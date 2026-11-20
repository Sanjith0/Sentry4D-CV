"""Minimal, dependency-free GLB writer/reader for one skinned, animated, textured body.

Layout written (and expected by src/features/reconstruction/AvatarLayer.tsx):
  scene -> "avatar" (root, identity)
             |- "Hips" ... 52 joint nodes (rest rotation = identity, translation = offset to parent)
             `- "body" (mesh + skin)
  animation "motion": translation of Hips (room coordinates, metres) + rotation of every posed
  joint, one key per master-clock sample (time = k / fps, so clipTime = masterTime - t0).
"""
import json, struct
import numpy as np


def _pad(b, fill=b"\x00"):
    return b + fill * ((4 - len(b) % 4) % 4)


class _Buf:
    def __init__(self):
        self.data = bytearray()
        self.views = []
        self.accessors = []

    def view(self, raw, target=None):
        off = len(self.data)
        self.data += _pad(bytes(raw))
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(raw)}
        if target:
            v["target"] = target
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, arr, ctype, atype, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        a = {"bufferView": self.view(arr.tobytes(), target), "componentType": ctype, "count": int(arr.shape[0]), "type": atype}
        if minmax:
            a["min"] = arr.reshape(arr.shape[0], -1).min(0).astype(float).tolist()
            a["max"] = arr.reshape(arr.shape[0], -1).max(0).astype(float).tolist()
        if normalized:
            a["normalized"] = True
        self.accessors.append(a)
        return len(self.accessors) - 1


FLOAT, U8, U16, U32 = 5126, 5121, 5123, 5125


def vertex_normals(v, f):
    n = np.zeros_like(v)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    for i in range(3):
        np.add.at(n, f[:, i], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def split_uv(faces, face_uv):
    """Unique (vertex, uv) pairs -> render vertices. Returns (vmap, uvmap, new_faces)."""
    pairs = np.stack([faces.reshape(-1), face_uv.reshape(-1)], 1)
    uniq, inv = np.unique(pairs, axis=0, return_inverse=True)
    return uniq[:, 0], uniq[:, 1], inv.reshape(-1, 3)


def write_glb(path, *, v, faces, uv, face_uv, w, wi, heads, parents, labels, times, root_pos, quats, anim_joints,
              texture=None, texture_mime="image/jpeg", extras=None, name="avatar", static_quats=None, normals=None):
    """v (V,3) rest vertices; heads (J,3) rest joint positions; quats (N, len(anim_joints), 4) xyzw
    local rotations; root_pos (N,3) world position of joint 0; times (N,) seconds."""
    v, heads = np.asarray(v, np.float32), np.asarray(heads, np.float32)
    vmap, uvmap, tris = split_uv(np.asarray(faces), np.asarray(face_uv))
    nrm = (vertex_normals(v.astype(np.float64), np.asarray(faces)) if normals is None else np.asarray(normals)).astype(np.float32)
    pos = v[vmap]
    tex = np.asarray(uv, np.float32)[uvmap].copy()
    tex[:, 1] = 1.0 - tex[:, 1]                      # glTF: origin top-left
    b = _Buf()
    idx_type = (U16, np.uint16) if len(vmap) < 65536 else (U32, np.uint32)
    a_idx = b.accessor(tris.reshape(-1).astype(idx_type[1]), idx_type[0], "SCALAR", target=34963)
    a_pos = b.accessor(pos, FLOAT, "VEC3", target=34962, minmax=True)
    a_nrm = b.accessor(nrm[vmap], FLOAT, "VEC3", target=34962)
    a_uv = b.accessor(tex, FLOAT, "VEC2", target=34962)
    a_j = b.accessor(np.asarray(wi)[vmap].astype(np.uint8), U8, "VEC4", target=34962)
    a_w = b.accessor(np.asarray(w, np.float32)[vmap], FLOAT, "VEC4", target=34962)
    J = len(labels)
    ibm = np.tile(np.eye(4, dtype=np.float32), (J, 1, 1))
    ibm[:, :3, 3] = -heads
    a_ibm = b.accessor(ibm.transpose(0, 2, 1).reshape(J, 16), FLOAT, "MAT4")   # column-major

    nodes = [{"name": name, "children": [1, J + 1]}]
    children = {j: [] for j in range(J)}
    for j, p in enumerate(parents):
        if p >= 0:
            children[p].append(j)
    for j in range(J):
        off = heads[j] - (heads[parents[j]] if parents[j] >= 0 else 0)
        rq = [0.0, 0.0, 0.0, 1.0] if not static_quats or j not in static_quats else [float(x) for x in static_quats[j]]
        n = {"name": labels[j], "translation": [float(x) for x in off], "rotation": rq}
        if children[j]:
            n["children"] = [c + 1 for c in children[j]]
        nodes.append(n)
    nodes.append({"name": "body", "mesh": 0, "skin": 0})

    material = {"name": "subject", "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9}, "doubleSided": False}
    gltf = {
        "asset": {"version": "2.0", "generator": "Sentry4D avatar pipeline (experiments/reconstruction/avatar)"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes,
        "meshes": [{"name": "body", "primitives": [{"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "TEXCOORD_0": a_uv, "JOINTS_0": a_j, "WEIGHTS_0": a_w}, "indices": a_idx, "material": 0}]}],
        "skins": [{"name": "rig", "joints": list(range(1, J + 1)), "skeleton": 1, "inverseBindMatrices": a_ibm}],
        "materials": [material],
    }
    if texture is not None:
        iv = b.view(texture)
        gltf["images"] = [{"bufferView": iv, "mimeType": texture_mime, "name": "albedo"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        gltf["textures"] = [{"sampler": 0, "source": 0}]
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    if times is not None:
        times = np.asarray(times, np.float32)
        a_t = b.accessor(times, FLOAT, "SCALAR", minmax=True)
        samplers = [{"input": a_t, "output": b.accessor(np.asarray(root_pos, np.float32), FLOAT, "VEC3"), "interpolation": "LINEAR"}]
        channels = [{"sampler": 0, "target": {"node": 1, "path": "translation"}}]
        q = np.asarray(quats, np.float64).copy()
        q /= np.linalg.norm(q, axis=-1, keepdims=True)
        for i in range(1, q.shape[0]):                # keep each track on one hemisphere (clean slerp)
            flip = (q[i] * q[i - 1]).sum(-1) < 0
            q[i, flip] *= -1
        for a, j in enumerate(anim_joints):
            samplers.append({"input": a_t, "output": b.accessor(q[:, a].astype(np.float32), FLOAT, "VEC4"), "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": j + 1, "path": "rotation"}})
        gltf["animations"] = [{"name": "motion", "samplers": samplers, "channels": channels}]
    if extras:
        gltf["scenes"][0]["extras"] = extras
    gltf["bufferViews"], gltf["accessors"] = b.views, b.accessors
    gltf["buffers"] = [{"byteLength": len(b.data)}]
    js = _pad(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(b.data)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(b.data), 0x004E4942) + bytes(b.data))
    return len(vmap)


# ---- reader + reference skinning (used by validate.py to prove the export equals the fit) ----
_NP = {5126: np.float32, 5121: np.uint8, 5123: np.uint16, 5125: np.uint32}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    raw = open(path, "rb").read()
    jl = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + jl])
    bin_ = raw[20 + jl + 8:]

    def acc(i):
        a = gltf["accessors"][i]
        v = gltf["bufferViews"][a["bufferView"]]
        n = _NC[a["type"]]
        arr = np.frombuffer(bin_, _NP[a["componentType"]], a["count"] * n, v.get("byteOffset", 0) + a.get("byteOffset", 0))
        return arr.reshape(a["count"], n) if n > 1 else arr
    return gltf, acc


def _q2m(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def skin_from_glb(path, key):
    """Evaluate the GLB at animation key `key` exactly as the glTF spec prescribes."""
    gltf, acc = read_glb(path)
    nodes = gltf["nodes"]
    T = {i: np.array(n.get("translation", [0, 0, 0]), float) for i, n in enumerate(nodes)}
    Q = {i: np.array(n.get("rotation", [0, 0, 0, 1]), float) for i, n in enumerate(nodes)}
    an = gltf["animations"][0]
    for ch in an["channels"]:
        out = acc(an["samplers"][ch["sampler"]]["output"])[key]
        (T if ch["target"]["path"] == "translation" else Q)[ch["target"]["node"]] = out.astype(float)
    world = {}

    def visit(i, M):
        L = np.eye(4); L[:3, :3] = _q2m(Q[i] / np.linalg.norm(Q[i])); L[:3, 3] = T[i]
        world[i] = M @ L
        for c in nodes[i].get("children", []):
            visit(c, world[i])
    for r in gltf["scenes"][0]["nodes"]:
        visit(r, np.eye(4))
    skin = gltf["skins"][0]
    ibm = acc(skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
    JM = np.stack([world[j] @ ibm[i] for i, j in enumerate(skin["joints"])])
    prim = gltf["meshes"][0]["primitives"][0]["attributes"]
    pos, jn, wt = acc(prim["POSITION"]).astype(float), acc(prim["JOINTS_0"]), acc(prim["WEIGHTS_0"]).astype(float)
    ph = np.concatenate([pos, np.ones((len(pos), 1))], 1)
    out = np.zeros((len(pos), 3))
    for k in range(4):
        out += wt[:, k:k + 1] * np.einsum("vij,vj->vi", JM[jn[:, k]], ph)[:, :3]
    return out

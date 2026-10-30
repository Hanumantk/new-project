"""
Converts the hand model from Blender to public/models/Hand.glb.

Keeps the left hand (Hand.L on armature Hand_Left), renames its deform bones
to the names src/lib/xrHandModel.ts drives, drops the IK control bones, sets
the rest pose and exports at a chosen Multires level (3 = full detail, ~70,000
vertices; 2 = ~17,500).

    pip install bpy==5.2.3   # Blender as a Python module (Python 3.13)
    python scripts/hand-model/export_hand.py "Hands_ armature.blend" public/models/Hand.glb 3
"""
import bpy, sys
src, out, level = sys.argv[-3], sys.argv[-2], int(sys.argv[-1])
bpy.ops.wm.open_mainfile(filepath=src)
RENAME = {
    'Bone.020': 'forearm', 'Bone.016': 'radius_ulna',
    'Bone.012': 'index_meta', 'Bone': 'index_prox', 'Bone.001': 'index_midd', 'Bone.002': 'index_dist',
    'Bone.013': 'midd_meta', 'Bone.003': 'midd_prox', 'Bone.004': 'midd_midd', 'Bone.005': 'midd_dist',
    'Bone.014': 'ring_meta', 'Bone.006': 'ring_prox', 'Bone.007': 'ring_midd', 'Bone.008': 'ring_dist',
    'Bone.015': 'pinky_meta', 'Bone.009': 'pinky_prox', 'Bone.010': 'pinky_midd', 'Bone.011': 'pinky_dist',
    'Bone.021': 'thumb_trapez', 'Bone.017': 'thumb_meta', 'Bone.018': 'thumb_prox', 'Bone.019': 'thumb_dist',
}
# Keep only the left hand and its armature.
keep = {'Hand.L', 'Hand_Left'}
for o in list(bpy.data.objects):
    if o.name not in keep:
        bpy.data.objects.remove(o, do_unlink=True)
arm = bpy.data.objects['Hand_Left']
hand = bpy.data.objects['Hand.L']
arm.data.pose_position = 'REST'
for pb in arm.pose.bones:
    for c in list(pb.constraints):
        pb.constraints.remove(c)
# Rename bones (vertex groups follow) and drop the IK control bones.
for b in arm.data.bones:
    if b.name in RENAME:
        b.name = RENAME[b.name]
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for eb in list(arm.data.edit_bones):
    if 'control' in eb.name:
        arm.data.edit_bones.remove(eb)
bpy.ops.object.mode_set(mode='OBJECT')
print('groups', [g.name for g in hand.vertex_groups])
md = [m for m in hand.modifiers if m.type == 'MULTIRES'][0]
md.levels = level
md.render_levels = level
for o in bpy.data.objects:
    o.select_set(o.name in keep)
bpy.ops.export_scene.gltf(
    filepath=out, export_format='GLB', use_selection=True, export_apply=True, export_skins=True,
    export_def_bones=True, export_animations=False, export_yup=True, export_materials='NONE',
    export_texcoords=False, export_normals=True, export_morph=False,
)
print('exported', out)

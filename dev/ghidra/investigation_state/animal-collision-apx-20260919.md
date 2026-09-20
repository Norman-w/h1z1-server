# 动物碰撞资源审计（2026-09-19）

`tools/audit-animal-collision-apx.py` 已对客户端解包目录中的四个动物碰撞资源完成只读解析：

```text
Resources/Assets/unpacked/Bear_Brown_COL.apx
Resources/Assets/unpacked/Wolf001_COL.apx
Resources/Assets/unpacked/Deer001_COL.apx
Resources/Assets/unpacked/Rabbit_Tan_COL.apx
```

这些文件虽然使用 `.apx` 后缀，实际是 NvParameterized 二进制布局（头部 magic `5a 5b 5c 5d`，VcWin64 目标 ABI），不是可以直接按 XML 读取的文本。脚本校验了 header、根对象、对象引用、`ModelCollision` 记录数组和每个形状对象的边界。

审计结果：

| 资源 | 身体形状记录 | 形状对象 | 骨骼绑定 |
| --- | ---: | --- | ---: |
| Bear | 17 | 17 × `DynamicSystemCapsuleShapeParams` | 已读出 |
| Wolf | 24 | 24 × `DynamicSystemCapsuleShapeParams` | 已读出 |
| Deer | 16 | 15 × `DynamicSystemCapsuleShapeParams` + 1 × `DynamicSystemSphereShapeParams` | 已读出 |
| Rabbit | 23 | 23 × `DynamicSystemCapsuleShapeParams` | 已读出 |

每个胶囊对象的前两个浮点字段，以及球体对象的第一个浮点字段，已作为 `radiusCandidate` / `heightCandidate` 输出；每条记录还保留了骨骼、父骨骼、形状对象偏移和原始 pose 字段。它们是原生身体碰撞资源的候选几何，**不是**动物攻击武器的接触形状，也没有被写入 `Npc` 的攻击距离或伤害判定。

因此本轮可以确认：

1. 动物并非只有一个服务器上的点或统一半径，客户端资源确实为不同骨骼提供了多组身体形状。
2. 这些几何数据可以作为后续“玩家身体/动物身体相交”分析的输入，尤其能覆盖台阶、车辆等高度差问题。
3. 仍不能据此宣称攻击已按原生 `SwingContact` 命中；攻击武器/动作图的接触几何和运行时命中回执仍未绑定。

示例命令（Git Bash）：

```bash
python3 tools/audit-animal-collision-apx.py \
  --output /tmp/animal-collision-apx-20260919.json
```

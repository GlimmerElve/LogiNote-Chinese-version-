import React, { useRef, useEffect, useState } from "react";
import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import { NoteItem, GraphMode, VaultSettings } from "../types";
import {
  Network,
  RotateCcw,
  Search,
  ExternalLink,
  Eye,
  Layers,
  Trash2
} from "lucide-react";

interface GraphViewProps {
  notes: NoteItem[];
  onSelectNoteByTitle: (title: string) => void;
  onDeleteNote: (noteId: string) => void;
  settings: VaultSettings;
}

// 3D 图谱的节点/边扩展数据结构（源/目标用节点 id 字符串关联）
interface GNode {
  id: string;
  name: string;
  val: number;
  color: string;
  group: string;
  __noteType: string;
  __tags: string[];
  __dueDateCount: number;
  __isFavorite?: boolean;
  x?: number;
  y?: number;
  z?: number;
}

interface GLink {
  source: string;
  target: string;
  __type: "wiki" | "parent_child";
}

interface NodeVisual {
  name: string;
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  sprite: THREE.Sprite;
  setOpacity: (o: number) => void;
}

const makeTextSprite = (node: GNode, dark: boolean): THREE.Sprite => {
  const font = 'bold 15px "PingFang SC", "Microsoft YaHei", "-apple-system", "SF Pro Text", sans-serif';

  // 先用离屏 canvas 测量文字宽度，做像素级截断
  const measureCtx = document.createElement("canvas").getContext("2d")!;
  measureCtx.font = font;
  const maxWidth = 180;
  let display = node.name || "";
  if (measureCtx.measureText(display).width > maxWidth) {
    while (display.length > 1 && measureCtx.measureText(display + "…").width > maxWidth) {
      display = display.slice(0, -1);
    }
    display += "…";
  }

  const textWidth = Math.ceil(measureCtx.measureText(display).width);
  const pad = 14;
  const height = 28;
  const canvas = document.createElement("canvas");
  canvas.width = textWidth + pad * 2;
  canvas.height = height;

  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 半透明圆角胶囊背景，让文字与节点/边/背景分离，提升可读性
  const radius = Math.min(10, canvas.height / 2);
  ctx.fillStyle = dark ? "rgba(15, 23, 42, 0.85)" : "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
  } else {
    ctx.rect(0, 0, canvas.width, canvas.height);
  }
  ctx.fill();

  // 文字：描边 + 主体填充，两种背景都可读
  ctx.lineWidth = 2;
  ctx.strokeStyle = dark ? "rgba(0, 0, 0, 0.5)" : "rgba(255, 255, 255, 0.9)";
  ctx.fillStyle = dark ? "#FFFFFF" : "#0F172A";
  ctx.strokeText(display, canvas.width / 2, canvas.height / 2);
  ctx.fillText(display, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false
  });
  const sprite = new THREE.Sprite(mat);
  // 缩放系数控制文字在 3D 世界中的显示尺寸
  const scale = 0.9;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
};

export const GraphView: React.FC<GraphViewProps> = ({
  notes,
  onSelectNoteByTitle,
  onDeleteNote,
  settings
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);

  // 节点可视对象与边的快照，供 hover/搜索做即时高亮（直接操作 three 材质，零 React 渲染开销）
  const nodeVisualsRef = useRef<Map<string, NodeVisual>>(new Map());
  const linksRef = useRef<GLink[]>([]);

  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [repulsionForce, setRepulsionForce] = useState(Math.min(settings.graphPhysics.repulsion || 80, 150));
  const [linkDistance, setLinkDistance] = useState(settings.graphPhysics.linkDistance || 120);
  const [graphMode, setGraphMode] = useState<GraphMode>("knowledge");

  // 用 ref 镜像状态，供 once-effect 内的回调与 applyVisual/applyForces 直接读取最新值
  // 注意：这些 ref 的更新在各自事件回调里手动维护（不能依赖渲染时的赋值，否则同步回调读到旧值）
  const repulsionRef = useRef(repulsionForce);
  const linkDistanceRef = useRef(linkDistance);

  const selectedNodeRef = useRef<GNode | null>(null);
  const hoveredNodeRef = useRef<GNode | null>(null);
  const searchQueryRef = useRef("");

  // 深色模式判定
  const isDark = () => document.documentElement.classList.contains("dark");

  // 根据 hover / 选中 / 搜索，即时更新节点球体与文字的透明度
  const applyVisual = () => {
    const visuals = nodeVisualsRef.current;
    if (!graphRef.current) return;

    const active = hoveredNodeRef.current || selectedNodeRef.current;
    const connected = new Set<string>();
    if (active) {
      connected.add(active.id);
      linksRef.current.forEach((l) => {
        const s = typeof l.source === "object" ? (l.source as any).id : l.source;
        const t = typeof l.target === "object" ? (l.target as any).id : l.target;
        if (s === active.id) connected.add(t);
        if (t === active.id) connected.add(s);
      });
    }

    const q = searchQueryRef.current.trim().toLowerCase();
    visuals.forEach((v, id) => {
      const matchesSearch = !q || v.name.toLowerCase().includes(q);
      let opacity = matchesSearch ? 1 : 0.12;
      if (active) {
        if (id === active.id) opacity = 1;
        else if (connected.has(id)) opacity = 0.9;
        else opacity = 0.12;
      }
      v.setOpacity(opacity);
    });
  };

  // 应用斥力 / 链距到 d3 力对象（幂等，供 graphData 后与滑块变更复用）
  const applyForces = () => {
    const g = graphRef.current;
    if (!g) return;
    const charge = g.d3Force("charge") as any;
    if (charge) charge.strength(-repulsionRef.current);
    const link = g.d3Force("link") as any;
    if (link) link.distance(linkDistanceRef.current);
  };

  // 一次性挂载 3D 图谱实例与静态配置
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const graph: any = new ForceGraph3D(el, {
      controlType: "orbit",
      // 关键：关闭 canvas 透明通道，避免与 Electron transparent 窗口的 GPU 合成冲突导致白屏
      rendererConfig: { alpha: false }
    });
    graphRef.current = graph;

    // —— 关键：锁定为 2D（力只作用于 x/y 平面，z 恒为 0）——
    graph.numDimensions(2);
    graph.backgroundColor(isDark() ? "#0F172A" : "#FFFFFF");

    // 禁用旋转，只保留平移 + 缩放，体验等同 2D 图谱
    const controls = graph.controls() as any;
    if (controls && "enableRotate" in controls) controls.enableRotate = false;

    // 相机正对 z=0 平面
    graph.cameraPosition({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 0);

    // 节点：自定义球体 + 文字标签（完全自定义，不叠加默认球体）
    graph.nodeThreeObject((node: GNode) => {
      const dark = isDark();
      const radius = 5 + Math.min((node.val || 1) * 2.5, 22);
      const group = new THREE.Group();

      const geo = new THREE.SphereGeometry(radius, 24, 24);
      const mat = new THREE.MeshLambertMaterial({
        color: node.color || "#3B82F6",
        transparent: true
      });
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);

      const sprite = makeTextSprite(node, dark);
      sprite.position.y = -radius - 14;
      group.add(sprite);

      nodeVisualsRef.current.set(node.id, {
        name: node.name,
        mesh,
        mat,
        sprite,
        setOpacity: (o: number) => {
          mat.opacity = o;
          mat.transparent = true;
          mat.needsUpdate = true;
          const sm = sprite.material as THREE.SpriteMaterial;
          sm.opacity = o;
          sm.transparent = true;
          sm.needsUpdate = true;
        }
      });
      return group;
    });

    // 边样式
    graph.linkWidth((l: GLink) => (l.__type === "parent_child" ? 0.6 : 1.1));
    graph.linkColor((l: GLink) =>
      l.__type === "parent_child" ? "rgba(148, 163, 184, 0.45)" : "rgba(100, 116, 139, 0.55)"
    );
    graph.linkOpacity(1);

    // 提示标签
    graph.nodeLabel((n: GNode) => n.name);

    // 交互
    graph.enableNodeDrag(true);
    graph.onNodeClick((node: GNode) => {
      selectedNodeRef.current = node;
      setSelectedNode(node);
      applyVisual();
    });
    graph.onNodeHover((node: GNode | null) => {
      hoveredNodeRef.current = node;
      applyVisual();
    });
    graph.onBackgroundClick(() => {
      selectedNodeRef.current = null;
      setSelectedNode(null);
      applyVisual();
    });

    // 每帧保险：即使未来切换为 3D 或外力引入 z 漂移，也强制 z/vz 归零
    graph.onEngineTick(() => {
      const data = graph.graphData();
      if (!data || !data.nodes) return;
      data.nodes.forEach((n: any) => {
        n.z = 0;
        if (n.vz !== undefined) n.vz = 0;
      });
    });

    applyForces();

    // 容器尺寸自适应
    const resize = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        graph.width(el.clientWidth);
        graph.height(el.clientHeight);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      graph._destructor();
      graphRef.current = null;
      nodeVisualsRef.current.clear();
      linksRef.current = [];
    };
  }, []);

  // 数据映射：沿用 filtering + 增量更新，z 恒为 0
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const isOverview = graphMode === "overview";
    const filtered = isOverview ? notes : notes.filter((n) => n.noteType === "knowledge");

    const prevById = new Map<any, GNode>();
    const existingData = graph.graphData();
    (existingData?.nodes || []).forEach((n: any) => prevById.set(n.id, n));

    const titleToNodeMap = new Map<string, GNode>();
    const newNodes: GNode[] = filtered.map((note, idx) => {
      const degree = (note.links || []).length + (note.backlinks || []).length;
      const isProject = note.noteType === "project";
      const old = prevById.get(note.id);

      const base = {
        id: note.id,
        name: note.title,
        val: Math.max(degree, 1),
        group: isProject ? "Project" : note.tags?.[0] || "Knowledge",
        color: isProject ? "#10B981" : note.color || (idx % 2 === 0 ? "#3B82F6" : "#8B5CF6"),
        __noteType: note.noteType,
        __tags: note.tags || [],
        __dueDateCount: note.dueDates.filter((d) => !d.completed).length,
        __isFavorite: note.isFavorite
      };

      if (old) {
        // 保留旧坐标/速度，仅刷新展示字段
        const node: GNode = { ...old, ...base, x: old.x, y: old.y, z: 0 };
        titleToNodeMap.set(note.title, node);
        return node;
      }

      // 新节点：在 x/y 平面随机撒点，z 固定 0
      const angle = (idx / Math.max(filtered.length, 1)) * Math.PI * 2;
      const radius = 120 + Math.random() * 40;
      const node: GNode = {
        ...base,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: 0
      };
      titleToNodeMap.set(note.title, node);
      return node;
    });

    // 清理已删除节点的可视对象缓存
    const validIds = new Set(newNodes.map((n) => n.id));
    const visuals = nodeVisualsRef.current;
    visuals.forEach((_, id) => {
      if (!validIds.has(id)) visuals.delete(id);
    });

    // 构建边
    const newLinks: GLink[] = [];
    filtered.forEach((sourceNote) => {
      const sourceNode = titleToNodeMap.get(sourceNote.title);
      if (!sourceNode) return;
      (sourceNote.links || []).forEach((targetTitle) => {
        const targetNode = titleToNodeMap.get(targetTitle);
        if (targetNode)
          newLinks.push({ source: sourceNode.id, target: targetNode.id, __type: "wiki" });
      });
    });

    if (isOverview) {
      const idToNodeMap = new Map<string, GNode>();
      newNodes.forEach((n) => idToNodeMap.set(n.id, n));
      filtered.forEach((note) => {
        if (note.parentId) {
          const parentNode = idToNodeMap.get(note.parentId);
          const childNode = idToNodeMap.get(note.id);
          if (parentNode && childNode)
            newLinks.push({ source: parentNode.id, target: childNode.id, __type: "parent_child" });
        }
      });
    }

    linksRef.current = newLinks;
    graph.graphData({ nodes: newNodes, links: newLinks });
    // graphData 会重新初始化 link force（charge strength / link distance 会回默认），需在此重新应用
    applyForces();
    applyVisual();
  }, [notes, graphMode]);

  const resetView = () => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.cameraPosition({ x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: 0 }, 400);
  };

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] relative overflow-hidden select-none">
      {/* 3D 容器（不透明背景，配合 rendererConfig.alpha=false 规避 Electron 透明窗口白屏） */}
      <div ref={containerRef} className="absolute inset-0 bg-white dark:bg-slate-900" />

      {/* 顶部悬浮控制条 */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md p-2 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-lg text-xs">
        <div className="flex items-center gap-1.5 px-2">
          <Search className="w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="在知识图谱中过滤..."
            value={searchQuery}
            onChange={(e) => {
              const v = e.target.value;
              setSearchQuery(v);
              searchQueryRef.current = v;
              applyVisual();
            }}
            className="bg-transparent focus:outline-none w-36 text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400"
          />
        </div>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800" />

        <div className="flex items-center gap-0.5 px-1 text-[10px]">
          <button
            onClick={() => setGraphMode("knowledge")}
            className={`px-2.5 py-1 rounded-lg font-medium transition ${
              graphMode === "knowledge"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            <Eye className="w-3 h-3 inline mr-1" />
            知识关联
          </button>
          <button
            onClick={() => setGraphMode("overview")}
            className={`px-2.5 py-1 rounded-lg font-medium transition ${
              graphMode === "overview"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            }`}
          >
            <Layers className="w-3 h-3 inline mr-1" />
            项目概览
          </button>
        </div>

        <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-800" />

        <div className="flex items-center gap-1.5 px-2">
          <span className="text-[10px] text-slate-500 font-medium">斥力:</span>
          <input
            type="range"
            min="20"
            max="200"
            value={repulsionForce}
            onChange={(e) => {
              const v = Number(e.target.value);
              setRepulsionForce(v);
              repulsionRef.current = v;
              applyForces();
            }}
            className="w-16 accent-blue-600"
          />
        </div>

        <div className="flex items-center gap-1.5 px-2">
          <span className="text-[10px] text-slate-500 font-medium">链距:</span>
          <input
            type="range"
            min="50"
            max="300"
            value={linkDistance}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLinkDistance(v);
              linkDistanceRef.current = v;
              applyForces();
            }}
            className="w-16 accent-blue-600"
          />
        </div>

        <button
          onClick={resetView}
          className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition"
          title="重置居中视角"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 右侧抽屉：选中节点预览卡 */}
      {selectedNode && (
        <div className="absolute top-4 right-4 z-20 w-80 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl p-4 rounded-2xl comic-card text-xs space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                Graph Node
              </span>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                {selectedNode.name}
              </h3>
            </div>
            <button
              onClick={() => {
                selectedNodeRef.current = null;
                setSelectedNode(null);
                applyVisual();
              }}
              className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              ✕
            </button>
          </div>

          <div className="space-y-1 text-slate-600 dark:text-slate-300">
            <p className="flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-blue-500" />
              关联双链权重: <span className="font-bold">{selectedNode.val}</span>
            </p>
            {selectedNode.__tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {selectedNode.__tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-medium text-[10px] border border-indigo-200/50 dark:border-indigo-800/50"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => onSelectNoteByTitle(selectedNode.name)}
            className="w-full py-2 rounded-xl bg-blue-600 text-white font-semibold flex items-center justify-center gap-1.5 shadow-md hover:bg-blue-700 transition"
          >
            <span>跳转到该笔记编辑</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              const title = selectedNode.name;
              if (window.confirm(`确定要删除笔记「${title}」吗？此操作不可撤销。`)) {
                selectedNodeRef.current = null;
                setSelectedNode(null);
                onDeleteNote(selectedNode.id);
              }
            }}
            className="w-full py-2 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 font-semibold flex items-center justify-center gap-1.5 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/60 transition text-xs"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>删除该笔记</span>
          </button>
        </div>
      )}
    </div>
  );
};
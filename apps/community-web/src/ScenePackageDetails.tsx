import type {ScenePackageSummary} from '../../community-api/src/scenePackageTypes';

const services={execution:'本地执行',model:'模型调用',resources:'选定资源读取'};
export function ScenePackageDetails({value}:{value:ScenePackageSummary}){
  const s2=value.kind==='scene-pack';
  return <div className="service-scene-package" aria-label="场景包信息">
    <p className="service-scene-package-kind">{s2?'S2 场景插件包':'H5P 互动场景包'}{s2&&<> · {value.packageVersion}</>}</p>
    <p>{s2?'下载 ZIP 后，在 LogiNote 场景入口选择「导入或更新 S2 交互包」。':'下载 .h5p 后，在 LogiNote「本地互动场景」选择「导入 .h5p」。'}</p>
    {value.kind==='h5p'&&value.missing.length>0&&<p role="status" className="inline-status">此包可以下载，但缺少兼容依赖或需要更新的 H5P 核心，当前终端暂不能播放。</p>}
    <details><summary>兼容要求与包信息</summary><dl>
      <dt>包名称</dt><dd>{value.name}</dd>
      {s2?<><dt>包标识</dt><dd>{value.packageId}</dd><dt>兼容接口</dt><dd>S2 API {value.paradigmApiVersion} · 包协议 {value.protocolVersion}</dd><dt>所需服务</dt><dd>{value.requiredServices.map(item=>services[item]).join('、')||'未声明宿主服务'}</dd><dt>包内物料</dt><dd>{value.materialCount} 项</dd></>:<><dt>内容类型</dt><dd>{value.mainLibrary}</dd><dt>依赖库</dt><dd>{value.libraries.join('、')}</dd>{value.missing.length>0&&<><dt>待补依赖</dt><dd>{value.missing.join('、')}</dd></>}</>}
      <dt>文件数量</dt><dd>{value.fileCount}</dd><dt>展开大小</dt><dd>{value.expandedBytes<1048576?`${Math.ceil(value.expandedBytes/1024)} KB`:`${(value.expandedBytes/1048576).toFixed(1)} MB`}</dd>
    </dl><p className="meta">{s2?'S2 包包含可执行代码，与应用主界面具有相同信任级别；请只安装可信来源。':'H5P 在终端隔离窗口运行，外链媒体和缺失依赖不会自动联网加载。'} 包结构与完整性检查不等于代码安全审计。网站只展示说明，不运行包代码。</p></details>
  </div>;
}

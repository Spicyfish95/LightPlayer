/**
 * electron-builder 收尾钩子（afterAllArtifactBuild）：构建后只保留最终压缩包。
 *
 * 为什么需要它：
 *  - `win-unpacked/` 是打包的中间目录，zip 就是从它压缩出来的，产物生成后即无用；
 *  - `builder-debug.yml` 由 electron-builder 的 DebugLogger 自动落盘，默认始终启用，
 *    没有配置项可以关闭（见 builder-util/out/DebugLogger.js 与 app-builder-lib/out/packager.js）。
 *
 * 该钩子在 `packager.build()` 全部完成（压缩包已生成）之后执行，因此删除这两个路径是安全的。
 * 若某次构建想保留 win-unpacked（例如要直接跑免安装目录做调试），
 * 可临时把 package.json 里的 `afterAllArtifactBuild` 去掉再构建。
 */
const fs = require('fs');
const path = require('path');

const INTERMEDIATE = ['win-unpacked', 'builder-debug.yml'];

async function afterAllArtifactBuild(buildResult) {
  const outDir = buildResult.outDir;
  for (const name of INTERMEDIATE) {
    const target = path.join(outDir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`  • 已清理中间产物  file=${target}`);
    } catch (error) {
      console.warn(`  • 清理失败（可手动删除）  file=${target}  reason=${error.message}`);
    }
  }
  return [];   // 不追加额外产物
}

module.exports = afterAllArtifactBuild;
module.exports.default = afterAllArtifactBuild;
module.exports.afterAllArtifactBuild = afterAllArtifactBuild;

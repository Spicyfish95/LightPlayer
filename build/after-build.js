/**
 * electron-builder 收尾钩子。
 *
 * afterPack：对 win-unpacked/resources/app.asar 内的应用源码做压缩混淆
 *   （JS: terser 压缩 + 混淆局部变量名；CSS: 去注释空白；HTML: 去注释空白），
 *   然后重新打包 asar。原生模块与 sherpa-onnx（asarUnpack）不受影响。
 * afterAllArtifactBuild：构建后只保留最终压缩包。
 *
 * 为什么需要清理钩子：
 *  - `win-unpacked/` 是打包的中间目录，zip 就是从它压缩出来的，产物生成后即无用；
 *  - `builder-debug.yml` 由 electron-builder 的 DebugLogger 自动落盘，默认始终启用，
 *    没有配置项可以关闭（见 builder-util/out/DebugLogger.js 与 app-builder-lib/out/packager.js）。
 *
 * terser / asar 依赖安装在 tools/（--no-save，见 tools/README.md），
 * 构建机首次构建前执行：npm install --prefix tools
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const INTERMEDIATE = ['win-unpacked', 'builder-debug.yml'];

// asar 内需要压缩混淆的文件（按扩展名分派处理方式）
const MANGLE_EXTS = new Set(['.js', '.css', '.html']);

function resolveTerser() {
  // electron-builder 会在项目根目录执行钩子；terser 装在 tools/node_modules
  const terserPkg = path.join(__dirname, '..', 'tools', 'node_modules', 'terser');
  return require(terserPkg);
}

function resolveAsar() {
  const asarPkg = path.join(__dirname, '..', 'tools', 'node_modules', 'asar');
  return require(asarPkg);
}

function minifyJs(code, file, terser) {
  const result = terser.minify(code, {
    compress: {
      passes: 2,
      drop_console: false,        // 保留 console：排障需要（体积收益极小）
      drop_debugger: true,
    },
    mangle: true,                 // 混淆局部变量/函数名
    format: { comments: false },  // 去除全部注释
    sourceMap: false,
  });
  if (result.error) throw new Error(`terser failed for ${file}: ${result.error.message}`);
  return result.code ?? code;   // 空文件等场景 terser 可能返回 undefined，回退原文
}

function minifyCss(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
    .replace(/\s+/g, ' ')                        // 连续空白
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')        // 语法符号周围空白
    .replace(/;}/g, '}')
    .trim();
}

function minifyHtml(code) {
  return code
    .replace(/<!--[\s\S]*?-->/g, '')             // 注释
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim();
}

async function afterPack(context) {
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return;

  const asar = resolveAsar();
  const terser = resolveTerser();

  // 1. 解包 asar 到临时目录
  const tmp = path.join(context.appOutDir, 'resources', 'app.asar.minify-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  await asar.extractAll(asarPath, tmp);

  // 2. 压缩混淆 src 下的文本资源（node_modules 只含 sherpa-onnx 的少量 js，体积可忽略，跳过）
  let saved = 0;
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!MANGLE_EXTS.has(path.extname(name))) continue;
      const before = stat.size;
      const code = fs.readFileSync(full, 'utf8');
      let out;
      const ext = path.extname(name);
      if (ext === '.js') out = minifyJs(code, path.relative(tmp, full), terser);
      else if (ext === '.css') out = minifyCss(code);
      else out = minifyHtml(code);
      fs.writeFileSync(full, out);
      saved += before - Buffer.byteLength(out);
    }
  };
  walk(path.join(tmp, 'src'));
  console.log(`  • asar 源码压缩混淆完成，减小 ${(saved / 1024).toFixed(1)} KB`);

  // 3. 重新打包 asar（顺序与原包一致；unpack dir 由 electron-builder 已单独存在 app.asar.unpacked，
  //    此处打包的是 asar 内的其余文件，包含 unpacked 占位目录不影响运行）
  await asar.createPackageWithOptions(tmp, asarPath, {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

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
module.exports.afterPack = afterPack;

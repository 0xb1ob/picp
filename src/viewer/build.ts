import { context } from "esbuild";
import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AppAsset, ViewerApp } from "./app-page.ts";

const MIME: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2" };
export async function buildViewer({ stateDir, packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..") }: { stateDir: string; packageRoot?: string }): Promise<ViewerApp> {
 const started = performance.now();
 const outdir = resolve(stateDir, "viewer-dist");
 mkdirSync(resolve(stateDir), { recursive: true });
 try { if (lstatSync(outdir).isSymbolicLink()) throw new Error("viewer-dist must not be a symlink"); }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
 mkdirSync(outdir, { recursive: true });
 const realDir = realpathSync(outdir);
 if (realDir !== join(realpathSync(stateDir), "viewer-dist")) throw new Error("viewer-dist escaped state directory");
 const build = await context({
  absWorkingDir: resolve(packageRoot), entryPoints: ["viewer-app/main.tsx"], outdir,
  bundle: true, platform: "browser", format: "esm", target: "es2022", jsx: "automatic", jsxImportSource: "preact",
  minify: true, sourcemap: false, metafile: true, write: false,
  loader: { ".woff2": "file" }, entryNames: "[name]-[hash]", assetNames: "[name]-[hash]", publicPath: "/assets/viewer", logLevel: "silent",
 });
 let timer: ReturnType<typeof setTimeout> | undefined;
 let timedOut = false;
 try {
  const result = await Promise.race([
   build.rebuild(),
   new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("viewer build exceeded 30 seconds")); }, 30_000); }),
  ]);
  const assets: Record<string, AppAsset> = Object.create(null);
  let bytes = 0;
  for (const file of result.outputFiles ?? []) {
   const mime = MIME[extname(file.path)];
   if (!mime || dirname(file.path) !== outdir || !/^[A-Za-z0-9_-]+\.(js|css|woff2)$/.test(basename(file.path))) throw new Error("unexpected viewer build output");
   if (realpathSync(outdir) !== realDir || lstatSync(outdir).isSymbolicLink()) throw new Error("viewer output directory changed");
   const temp = join(realDir, `.${basename(file.path)}-${randomBytes(8).toString("hex")}.tmp`);
   writeFileSync(temp, file.contents, { flag: "wx" });
   renameSync(temp, join(realDir, basename(file.path)));
   assets[`/assets/viewer/${basename(file.path)}`] = Object.freeze({ bytes: file.contents, mime });
   bytes += file.contents.length;
  }
  const entry = Object.entries(result.metafile!.outputs).find(([, metadata]) => metadata.entryPoint?.endsWith("viewer-app/main.tsx"));
  if (!entry || !entry[1].cssBundle) throw new Error("viewer build has no JS/CSS entry");
  return Object.freeze({ script: `/assets/viewer/${basename(entry[0])}`, stylesheet: `/assets/viewer/${basename(entry[1].cssBundle)}`, assets: Object.freeze(assets), duration_ms: Math.round(performance.now() - started), bytes });
 } finally {
  clearTimeout(timer);
  try { if (timedOut) await build.cancel(); }
  finally { await build.dispose(); }
 }
}

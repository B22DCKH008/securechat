#!/usr/bin/env node
/**
 * Đồng bộ model đã train (ml/models/artifacts) sang frontend:
 *   - public/models/          : file model + manifest.json (được serve tĩnh)
 *   - tests/fixtures/ai-real/ : fixtures parity (để `npm test` kiểm TS khớp Python trên model THẬT)
 *
 * Dùng:
 *   npm run models:sync                 # lấy từ ../ml/models/artifacts
 *   npm run models:sync -- --demo       # lấy từ ../ml/models/demo_artifacts (model demo, số đo vô nghĩa)
 *   npm run models:sync -- --from <dir> # thư mục artifacts khác
 *
 * Tùy chọn nội bộ (dùng để tạo tests/fixtures/ai-demo):
 *   --public-dir <dir> --fixtures-dir <dir> --all-url-models
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const demo = flag('--demo');
const from = resolve(
  root,
  opt('--from', demo ? '../ml/models/demo_artifacts' : '../ml/models/artifacts'),
);
const publicDir = resolve(root, opt('--public-dir', 'public/models'));
const fixturesDir = resolve(
  root,
  opt('--fixtures-dir', demo ? 'tests/fixtures/ai-demo' : 'tests/fixtures/ai-real'),
);
const allUrl = flag('--all-url-models');

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const size = (p) => statSync(p).size;

if (!existsSync(from))
  fail(`Không thấy ${from}. Chạy huấn luyện + export ở ml/ trước (xem ml/README.md).`);
mkdirSync(publicDir, { recursive: true });
mkdirSync(fixturesDir, { recursive: true });

const manifest = { schema: 'securechat.models/1', generatedAt: new Date().toISOString(), demo };
const copy = (src, dstDir, name = src.split(/[\\/]/).pop()) => {
  cpSync(src, join(dstDir, name));
  return join(dstDir, name);
};

// ---- model tin nhắn
const msgDir = join(from, 'message');
if (existsSync(join(msgDir, 'message_model.json'))) {
  const dst = copy(join(msgDir, 'message_model.json'), publicDir);
  const m = readJson(dst);
  manifest.message = { file: 'message_model.json', modelVersion: m.modelVersion, bytes: size(dst) };
  copy(join(msgDir, 'message_parity_fixtures.json'), fixturesDir);
  copy(dst, fixturesDir);
  console.log(
    `✓ message  ${m.modelVersion}  ${(size(dst) / 1024).toFixed(0)} KiB  vocab=${m.vocab.length}`,
  );
} else {
  console.warn('! Không có model tin nhắn (message_model.json) — bỏ qua.');
}

// ---- model URL
const urlDir = join(from, 'url');
if (existsSync(join(urlDir, 'url_spec.json'))) {
  const report = readJson(join(urlDir, 'url_export_report.json'));
  const spec = readJson(join(urlDir, 'url_spec.json'));
  const selected = report.selected ?? 'lr'; // chưa model nào đạt ngưỡng => dùng LR nhưng ghi meetsBar=false
  const entry = report.models?.[selected];
  if (!entry?.file)
    fail(`Model URL "${selected}" không có file export (xem url_export_report.json).`);
  copy(join(urlDir, 'url_spec.json'), publicDir);
  const dst = copy(join(urlDir, entry.file), publicDir);
  manifest.url = {
    kind: selected,
    file: entry.file,
    specFile: 'url_spec.json',
    modelVersion: spec.modelVersion,
    threshold: entry.threshold,
    meetsBar: report.selected ? true : false,
    bytes: size(dst),
  };
  copy(join(urlDir, 'url_parity_fixtures.json'), fixturesDir);
  copy(join(urlDir, 'url_spec.json'), fixturesDir);
  if (allUrl) {
    for (const [name, e] of Object.entries(report.models))
      if (e.file) copy(join(urlDir, e.file), fixturesDir);
  } else {
    copy(dst, fixturesDir);
  }
  console.log(
    `✓ url      ${spec.modelVersion}  model=${selected}  ${(size(dst) / 1024).toFixed(0)} KiB  meetsBar=${manifest.url.meetsBar}`,
  );
  if (!report.selected)
    console.warn(
      '! Chưa có model URL nào đạt ngưỡng chất lượng: đang dùng LR, meetsBar=false (báo cáo trung thực).',
    );
} else {
  console.warn('! Không có model URL (url_spec.json) — bỏ qua.');
}

writeFileSync(join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(fixturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// File WASM của onnxruntime-web KHÔNG chép ở đây: Vite đóng gói qua `?url` (src/ai/runtime/ortAssets.ts).

console.log(`→ ${publicDir}`);

/**
 * File .mjs + .wasm của onnxruntime-web, nạp qua Vite (`?url`) thay vì chép vào public/.
 *
 * Lý do: ở `npm run dev`, Vite KHÔNG cho import file nằm trong public/ ("should not be imported from source code"),
 * nên ORT không nạp được wasm. Với `?url`, dev lấy thẳng từ node_modules, còn build thì Vite tự đưa vào dist/assets
 * (kèm hash) — không cần script chép, không cần nhớ bước thủ công.
 *
 * Chi phí: dist có thêm 1 file wasm ~15 MB, nhưng trình duyệt chỉ tải nó khi model URL là ONNX thật sự cần.
 */
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export const ORT_WASM_PATHS = { mjs: ortMjs, wasm: ortWasm } as const;

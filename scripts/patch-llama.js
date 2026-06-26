// Patches llama.cpp b8750 to support Gemma 4 E4B/E2B shared KV layers.
//
// b8750 sets hparams.n_layer_kv_from_start correctly but doesn't use it
// when loading tensors: it marks wk (K weights) and attn_k_norm as required
// for ALL layers, even those that share KV from earlier layers and don't have
// those tensors in the GGUF file. This makes llama_model_load_from_file()
// return null when loading Gemma 4 E4B or E2B.
//
// Fix: mark wk and attn_k_norm as TENSOR_NOT_REQUIRED for non-KV layers
// (layers where hparams.has_kv(i) returns false). The inference code in
// gemma4-iswa.cpp already checks has_kv(il) and skips K/V computation for
// those layers, so nullptr wk/attn_k_norm is safe.

const fs = require('fs')
const path = require('path')

const filePath = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-llama-cpp',
  'llama',
  'llama.cpp',
  'src',
  'llama-model.cpp'
)

if (!fs.existsSync(filePath)) {
  console.error('llama-model.cpp not found — run `npm run llama:update` to download the source first')
  process.exit(1)
}

let content = fs.readFileSync(filePath, 'utf8')

// Multi-line context makes the replacement unique to the Gemma 4 tensor loading block
const OLD = `                        layer.wk = create_tensor(tn(LLM_TENSOR_ATTN_K,   "weight", i), {n_embd, n_embd_k}, 0);
                        layer.wv = create_tensor(tn(LLM_TENSOR_ATTN_V,   "weight", i), {n_embd, n_embd_v}, TENSOR_NOT_REQUIRED);
                        layer.wo = create_tensor(tn(LLM_TENSOR_ATTN_OUT, "weight", i), {n_embd_head * n_head, n_embd}, 0);

                        layer.attn_q_norm    = create_tensor(tn(LLM_TENSOR_ATTN_Q_NORM,    "weight", i), {n_embd_head}, 0);
                        layer.attn_k_norm    = create_tensor(tn(LLM_TENSOR_ATTN_K_NORM,    "weight", i), {n_embd_head}, 0);`

const NEW = `                        layer.wk = create_tensor(tn(LLM_TENSOR_ATTN_K,   "weight", i), {n_embd, n_embd_k}, hparams.has_kv(i) ? 0 : TENSOR_NOT_REQUIRED);
                        layer.wv = create_tensor(tn(LLM_TENSOR_ATTN_V,   "weight", i), {n_embd, n_embd_v}, TENSOR_NOT_REQUIRED);
                        layer.wo = create_tensor(tn(LLM_TENSOR_ATTN_OUT, "weight", i), {n_embd_head * n_head, n_embd}, 0);

                        layer.attn_q_norm    = create_tensor(tn(LLM_TENSOR_ATTN_Q_NORM,    "weight", i), {n_embd_head}, 0);
                        layer.attn_k_norm    = create_tensor(tn(LLM_TENSOR_ATTN_K_NORM,    "weight", i), {n_embd_head}, hparams.has_kv(i) ? 0 : TENSOR_NOT_REQUIRED);`

if (content.includes(NEW)) {
  console.log('Patch already applied, skipping')
} else if (!content.includes(OLD)) {
  console.error('Patch target not found in llama-model.cpp — the b8750 source may have changed')
  process.exit(1)
} else {
  content = content.replace(OLD, NEW)
  fs.writeFileSync(filePath, content, 'utf8')
  console.log('Applied Gemma 4 E4B/E2B shared KV layer patch to llama-model.cpp')
}

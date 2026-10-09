# Third-party components

Rush Music Studio's own code is MIT-licensed. These components are bundled unmodified:

| Component | Used for | Licence | Source |
|---|---|---|---|
| HTDemucs v4 (Hybrid Transformer Demucs) by Simon Rouard, Francisco Massa and Alexandre Défossez, Meta AI | AI stem separation model (desktop app) | MIT | https://github.com/facebookresearch/demucs · ONNX export: https://huggingface.co/adowu/htdemucs-onnx |
| ONNX Runtime Web, Microsoft | Runs the AI model (WebGPU / WebAssembly) | MIT | https://github.com/microsoft/onnxruntime |
| lamejs (JavaScript port of LAME) | MP3 export | LGPL-3.0 | https://github.com/zhuker/lamejs · https://lame.sourceforge.net |

Paper: S. Rouard, F. Massa, A. Défossez, "Hybrid Transformers for Music Source Separation", ICASSP 2023.

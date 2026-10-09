# Third-party components

Rush Music Studio's own code is MIT-licensed. These components are bundled (the network that runs the HTDemucs weights is Rush's own implementation):

| Component | Used for | Licence | Source |
|---|---|---|---|
| HTDemucs v4 (Hybrid Transformer Demucs) weights by Simon Rouard, Francisco Massa and Alexandre Défossez, Meta AI | AI stem separation model (converted to fp16, `rush-htdemucs.rsm`) | MIT | https://github.com/facebookresearch/demucs (checkpoint `955717e8-8726e21a.th`) |
| lamejs (JavaScript port of LAME) | MP3 export | LGPL-3.0 | https://github.com/zhuker/lamejs · https://lame.sourceforge.net |

Paper: S. Rouard, F. Massa, A. Défossez, "Hybrid Transformers for Music Source Separation", ICASSP 2023.

Demucs licence (applies to the model weights):

MIT License — Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Third-party notices

This package includes code and design derived from
[oh-my-pi](https://github.com/can1357/oh-my-pi), specifically the credential-free engine
chain and per-engine scrapers originally at:

- `packages/coding-agent/src/web/search/providers/public.ts`
- `packages/coding-agent/src/web/search/providers/startpage.ts`
- `packages/coding-agent/src/web/search/providers/duckduckgo.ts`
- `packages/coding-agent/src/web/search/providers/ecosia.ts`
- `packages/coding-agent/src/web/search/providers/google.ts`
- `packages/coding-agent/src/web/search/providers/mojeek.ts`

The ported portions are adapted to the DeepSeek Harness `ctx.web` seam with sequential
fail-forward semantics (Startpage first, then DuckDuckGo → Ecosia → Google → Mojeek).

oh-my-pi is distributed under the following MIT License:

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

All other code in this package is MIT (see LICENSE).
/* 页面交互
 *   - 配置：按语言区分缩进 / 行宽 / 空行上限，其余为全局；存 localStorage
 *   - 格式化：每次输出后跑语义等价 + 括号配平，UI 用 ✓ / ⚠ 表示
 *   - 差异：输出与输入做行级 LCS，区分「内容改动」与「仅缩进/空白改动」两类标记
 *   - 文件：拖入或选择本地文件载入，按扩展名切换语言
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var srcEl = $('src'), hlEl = $('hl'), outEl = $('out'), gutterEl = $('gutter');
  var inStat = $('inStat'), outStat = $('outStat'), verdictEl = $('verdict'), diffEl = $('diff');
  var KEY = 'fmt.cfg.v2';
  var LANGS = ['cpp', 'py', 'js', 'json'];

  var SAMPLES = {
    cpp: [
      '#include <vector>', '#include <string>', '#include <iostream>', '',
      'namespace demo{', 'template<typename T>', 'class Stack{', 'public:',
      'explicit Stack(size_t cap):buf_(cap),n_(0){}',
      'void push(const T& v){', 'if(n_>=buf_.size()){grow();}', 'buf_[n_++]=v;}',
      'void pop(){if(n_>0){--n_;}}',
      'const T& top()const{return buf_[n_-1];}',
      'bool empty()const{return n_==0;}',
      'private:', 'void grow(){buf_.resize(buf_.size()*2+1);}',
      'std::vector<T> buf_;  //backing store', 'size_t n_;', '};', '}', '',
      'int main(int argc,char** argv){',
      'demo::Stack<std::string> st;',
      'for(int i=0;i<argc;i++){st.push(argv[i]);}',
      'while(!st.empty()){',
      'std::cout<<st.top()<<"\\n";',
      'st.pop();', '}', 'return 0;', '}'
    ].join('\n'),
    py: [
      'import sys', 'from dataclasses import dataclass,field', 'from typing import Iterable', '',
      'MAX = 100', '',
      '@dataclass', 'class Item:',
      '    name:str', '    weight:float=1.0', '    tags:list=field(default_factory=list)',
      '    def label(self)->str:',
      '        return f"{self.name}({self.weight:g})"', '',
      'def kind(node):',
      '    match node:',
      '        case None:',
      '            return "none"',
      '        case [first,*rest] if rest:',
      '            return f"list({first})"',
      '        case _:',
      '            return type(node).__name__', '',
      'def load(rows:Iterable[str],limit:int=MAX)->list:',
      '    out=[]',
      '    for row in rows:',
      '        parts=[p.strip() for p in row.split(",") if p.strip()]',
      '        if not parts:continue',
      '        weight=float(parts[1]) if len(parts)>1 else 1.0',
      '        out.append(Item(name=parts[0],weight=weight,tags=parts[2:]))',
      '        if len(out)>=limit:break',
      '    return out', '',
      'def report(items:list)->None:',
      '    total=sum(i.weight for i in items)',
      '    for i,it in enumerate(items,1):',
      '        print(f"{i:>3}. {it.label():<20} {it.weight:6.2f}  {kind(it.tags)}")',
      '    print(',
      '        f"total: {total:.2f}",',
      '        file=sys.stderr,',
      '    )', '',
      'def main()->int:',
      '    rows=sys.stdin.read().splitlines()',
      '    items=load(',
      '            rows,',
      '            limit=20)',
      '    if not items:',
      '        print("nothing to do",file=sys.stderr)',
      '        return 1',
      '    try:',
      '        report(items)',
      '    except Exception as exc:',
      '        print(f"error: {exc}",file=sys.stderr)',
      '        return 2',
      '    return 0', '',
      'if __name__=="__main__":',
      '    raise SystemExit(main())'
    ].join('\n'),
    js: [
      "import {readFileSync} from 'node:fs'",
      "import path from 'node:path'", '',
      "const DEFAULTS={retries:3,timeout:1500,tags:['a','b']}", '',
      'export class Loader{',
      'constructor(root,opts={}){',
      'this.root=root',
      'this.opts={...DEFAULTS,...opts}',
      'this.cache=new Map()',
      '}',
      'load(name){',
      'const key=path.join(this.root,name)',
      'if(this.cache.has(key)){return this.cache.get(key)}',
      'let text',
      'try{',
      "text=readFileSync(key,'utf8')",
      '}catch(err){',
      "if(err.code!=='ENOENT')throw err",
      "text=''",
      '}',
      'const data=text.split(/\\r?\\n/).filter(function(l){return l.trim().length>0}).map(l=>l.trim())',
      'this.cache.set(key,data)',
      'return data',
      '}',
      'get size(){return this.cache.size}',
      '}', '',
      'export async function main(argv){',
      'const loader=new Loader(process.cwd(),{retries:5})',
      "const rows=loader.load(argv[2]||'list.txt')",
      'const total=rows.reduce((sum,row)=>{return sum+row.length},0)',
      'console.log(`loaded ${rows.length} rows, total ${total} chars`)',
      'return total>0?0:1',
      '}'
    ].join('\n'),
    json: [
      '{"name":"meraneko","version":"1.0.0","private":true,"tags":["front-end","tools"],',
      '"scripts":{"build":"node build.js","lint":"eslint ."},',
      '"deps":{"vue":"^3.4.0","pinia":"^2.1.7"},',
      '"nested":{"deep":{"list":[1,2,3],"flag":true,"none":null},',
      '"empty":{},"emptyList":[]},"count":42,"ratio":-0.75}'
    ].join('\n')
  };

  var DEF = {
    indent: { cpp: 4, py: 4, js: 2, json: 2 },
    width: { cpp: 100, py: 88, js: 80, json: 100 },
    blank: { cpp: 1, py: 2, js: 1, json: 0 },
    useTab: false,
    brace: 'attach',
    elseNewline: false,
    caseIndent: false,
    magicTrail: true,
    wrap: true,
    unwrap: true,
    align: false,
    sortImports: true,
    auto: true,
    preset: ''
  };
  var PRESETS = [
    { id: 'llvm', name: 'LLVM (C++)', lang: 'cpp', opts: { indent: 2, brace: 'attach', elseNewline: false, caseIndent: false, width: 80, blank: 1, wrap: true, unwrap: true, align: false, sortImports: true } },
    { id: 'google', name: 'Google (C++)', lang: 'cpp', opts: { indent: 2, brace: 'attach', elseNewline: false, caseIndent: false, width: 80, blank: 1, wrap: true, unwrap: true, align: false, sortImports: true } },
    { id: 'ms', name: 'Microsoft (C++)', lang: 'cpp', opts: { indent: 4, brace: 'allman', elseNewline: true, caseIndent: false, width: 120, blank: 1, wrap: true, unwrap: true, align: false, sortImports: true } },
    { id: 'gnu', name: 'GNU (C++)', lang: 'cpp', opts: { indent: 2, brace: 'allman', elseNewline: true, caseIndent: true, width: 79, blank: 1, wrap: false, unwrap: true, align: false, sortImports: false } },
    { id: 'prettier', name: 'Prettier (JS)', lang: 'js', opts: { indent: 2, brace: 'attach', elseNewline: false, caseIndent: true, width: 80, blank: 1, wrap: true, unwrap: true, align: false } },
    { id: 'black', name: 'black (Python)', lang: 'py', opts: { indent: 4, width: 88, blank: 2, magicTrail: true, wrap: true, unwrap: true, align: false, sortImports: true } },
    { id: 'pep8', name: 'PEP8 (Python)', lang: 'py', opts: { indent: 4, width: 79, blank: 2, magicTrail: true, wrap: false, unwrap: true, align: false, sortImports: true } },
    { id: 'json2', name: 'JSON 2 空格', lang: 'json', opts: { indent: 2 } },
    { id: 'json4', name: 'JSON 4 空格', lang: 'json', opts: { indent: 4 } }
  ];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  var cfg = { lang: 'cpp', indent: clone(DEF.indent), width: clone(DEF.width), blank: clone(DEF.blank) };
  ['useTab', 'brace', 'elseNewline', 'caseIndent', 'magicTrail', 'wrap', 'unwrap', 'align', 'sortImports', 'auto', 'preset'].forEach(function (k) { cfg[k] = DEF[k]; });

  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      LANGS.forEach(function (l) {
        ['indent', 'width', 'blank'].forEach(function (grp) {
          if (saved[grp] && typeof saved[grp][l] === 'number') cfg[grp][l] = saved[grp][l];
        });
      });
      Object.keys(cfg).forEach(function (k) {
        if (k === 'indent' || k === 'width' || k === 'blank') return;
        if (saved[k] !== undefined) cfg[k] = saved[k];
      });
    }
  } catch (e) { /* 配置坏了就用默认值 */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  function opts() {
    return {
      indent: cfg.indent[cfg.lang],
      useTab: cfg.useTab,
      brace: cfg.brace,
      elseNewline: cfg.elseNewline,
      caseIndent: cfg.caseIndent,
      magicTrail: cfg.magicTrail,
      wrap: cfg.wrap,
      unwrap: cfg.unwrap,
      align: cfg.align,
      sortImports: cfg.sortImports,
      width: cfg.width[cfg.lang],
      maxBlank: cfg.blank[cfg.lang]
    };
  }

  function isCustom() {
    var L2 = cfg.lang;
    return cfg.indent[L2] !== DEF.indent[L2] || cfg.width[L2] !== DEF.width[L2] ||
      (cfg.lang !== 'json' && cfg.blank[L2] !== DEF.blank[L2]) ||
      cfg.useTab !== DEF.useTab || cfg.brace !== DEF.brace || cfg.elseNewline !== DEF.elseNewline ||
      (cfg.lang !== 'py' && cfg.caseIndent !== true) || cfg.magicTrail !== DEF.magicTrail ||
      cfg.wrap !== DEF.wrap || cfg.unwrap !== DEF.unwrap || cfg.align !== DEF.align ||
      (cfg.lang !== 'json' && cfg.sortImports !== DEF.sortImports) || cfg.auto !== DEF.auto;
  }

  /* ---------- 统计 / 提示 ---------- */
  function stat(text) {
    var n = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
    return n + ' · ' + text.length;
  }
  function setVerdict(msgs, ms) {
    if (!msgs.length) {
      verdictEl.dataset.state = 'ok';
      verdictEl.textContent = '✓';
      verdictEl.title = '与输入语义一致（' + ms.toFixed(1) + ' ms）';
    } else {
      verdictEl.dataset.state = 'warn';
      verdictEl.textContent = '⚠';
      verdictEl.title = msgs.join('\n');
    }
  }

  /* ---------- 行级差异（LCS），区分内容改动与仅缩进改动 ---------- */
  function lcsMarks(a, b, norm) {
    var n = a.length, m = b.length;
    if (n * m > 2000000) return null;
    var X = new Array(n), Y = new Array(m), i, j;
    for (i = 0; i < n; i++) X[i] = norm(a[i]);
    for (j = 0; j < m; j++) Y[j] = norm(b[j]);
    var w = m + 1;
    var dp = new Uint16Array((n + 1) * w);
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i * w + j] = X[i] === Y[j] ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    var aM = {}, bM = {}, p = 0, q = 0;
    while (p < n && q < m) {
      if (X[p] === Y[q]) { p++; q++; continue; }
      if (dp[(p + 1) * w + q] >= dp[p * w + q + 1]) { aM[p] = 1; p++; }
      else { bM[q] = 1; q++; }
    }
    while (p < n) aM[p++] = 1;
    while (q < m) bM[q++] = 1;
    return { a: aM, b: bM };
  }
  function diffInfo(inText, outText) {
    var A = inText.replace(/\n$/, '').split('\n');
    var B = outText.replace(/\n$/, '').split('\n');
    if (inText === '') return null;
    var exact = lcsMarks(A, B, function (s) { return s; });
    if (!exact) return null;
    var trim = lcsMarks(A, B, function (s) { return s.trim(); });
    var content = {}, indentOnly = {}, i;
    for (i in exact.b) {
      if (exact.b[i]) content[i] = 1;
      else if (trim && trim.b[i]) indentOnly[i] = 1;
    }
    var aMarks = {};
    for (i in exact.a) aMarks[i] = 1;
    return { a: aMarks, b: content, bIndent: indentOnly, nContent: Object.keys(content).length, nIndent: Object.keys(indentOnly).length };
  }

  /* ---------- 输入层：高亮 + 行号 ---------- */
  var lastLineCount = -1;
  function paintInput(diff) {
    var r = FmtHL.lines(cfg.lang, srcEl.value);
    var html = '';
    for (var i = 0; i < r.html.length; i++) {
      var c = diff && diff.a[i] ? ' dl' : '';
      html += '<div class="sl' + c + '">' + (r.html[i] || '') + '</div>';
    }
    hlEl.innerHTML = html;
    var lines = r.html.length;
    if (lines !== lastLineCount) {
      var g = [];
      for (var k = 1; k <= lines; k++) g.push(k);
      gutterEl.textContent = g.join('\n');
      lastLineCount = lines;
    }
    inStat.textContent = stat(srcEl.value);
    syncScroll();
  }
  function syncScroll() {
    hlEl.style.transform = 'translate(' + (-srcEl.scrollLeft) + 'px,' + (-srcEl.scrollTop) + 'px)';
    gutterEl.style.transform = 'translateY(' + (-srcEl.scrollTop) + 'px)';
  }

  /* ---------- 格式化 ---------- */
  var outText = '';
  function formatText() {
    var src = srcEl.value;
    var res;
    if (cfg.lang === 'py') res = FmtPy.format(src, opts());
    else if (cfg.lang === 'js') res = FmtJs.format(src, opts());
    else if (cfg.lang === 'json') res = FmtJson.format(src, opts());
    else res = FmtCpp.format(src, opts());
    return res;
  }
  function run() {
    var src = srcEl.value;
    if (!src.trim()) {
      outEl.innerHTML = '';
      outText = '';
      outStat.textContent = stat('');
      diffEl.textContent = '';
      diffEl.removeAttribute('data-state');
      diffEl.title = '';
      verdictEl.textContent = '';
      verdictEl.removeAttribute('data-state');
      verdictEl.title = '';
      paintInput(null);
      return;
    }
    var t0 = performance.now();
    var res = formatText();
    var ms = performance.now() - t0;
    outText = res.code || '';

    var diff = diffInfo(src, outText);
    paintInput(diff);

    var html = FmtHL.lines(cfg.lang, outText.replace(/\n$/, '')).html;
    var buf = '';
    for (var i = 0; i < html.length; i++) {
      var cls = diff && diff.b[i] ? ' dc' : (diff && diff.bIndent[i] ? ' di' : '');
      buf += '<div class="ol' + cls + '">' + (html[i] || '') + '</div>';
    }
    outEl.innerHTML = buf;
    outStat.textContent = stat(outText);

    if (diff) {
      diffEl.textContent = (diff.nContent ? '+' + diff.nContent : '') + (diff.nIndent ? (diff.nContent ? ' ' : '') + '~' + diff.nIndent : '');
      diffEl.title = '共 ' + (diff.nContent + diff.nIndent) + ' 行有改动（仅缩进/空白 ' + diff.nIndent + ' 行）';
    } else {
      diffEl.textContent = '';
      diffEl.title = '';
    }

    var msgs = [];
    (res.errors || []).forEach(function (e) { msgs.push('第 ' + e.ln + ' 行：' + e.msg); });
    (res.warnings || []).forEach(function (w) { msgs.push(w); });
    var lex = FmtLex.lex(cfg.lang, outText);
    var bal = FmtLex.balance(lex.tokens);
    if (!bal.ok) msgs.push(bal.msg);
    if (bal.ok && !(res.errors || []).length) {
      var eq = FmtLex.equivalent(cfg.lang, src, outText);
      if (!eq.ok) msgs.push('结果与输入语义不一致：' + eq.msg);
    }
    setVerdict(msgs, ms);
  }

  var timer = 0;
  function scheduleRun() {
    if (!cfg.auto) return;
    clearTimeout(timer);
    timer = setTimeout(run, 160);
  }

  /* ---------- 控件 ---------- */
  function applyCfgToUi() {
    var L2 = cfg.lang;
    $('optIndent').value = cfg.useTab ? 'tab' : String(cfg.indent[L2]);
    $('optBrace').value = cfg.brace;
    $('optElse').value = cfg.elseNewline ? 'newline' : 'join';
    $('optCase').value = cfg.caseIndent ? 'indent' : 'align';
    $('optMagic').checked = cfg.magicTrail;
    $('optWrap').checked = cfg.wrap;
    $('optUnwrap').checked = cfg.unwrap;
    $('optAlign').checked = cfg.align;
    $('optSort').checked = cfg.sortImports;
    $('optWidth').value = cfg.width[L2];
    $('optBlank').value = String(cfg.blank[L2]);
    $('optAuto').checked = cfg.auto;

    var els = document.querySelectorAll('#panel [data-lang]');
    for (var i = 0; i < els.length; i++) {
      els[i].hidden = els[i].dataset.lang.split(' ').indexOf(L2) < 0;
    }

    var sel = $('optPreset');
    var list = PRESETS.filter(function (p) { return p.lang === L2; });
    var opt = '<option value="">自定义</option>';
    list.forEach(function (p) {
      opt += '<option value="' + p.id + '"' + (cfg.preset === p.id ? ' selected' : '') + '>' + p.name + '</option>';
    });
    sel.innerHTML = opt;
    sel.value = cfg.preset || '';

    var btns = $('langSeg').querySelectorAll('button');
    for (i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-selected', btns[i].dataset.lang === L2 ? 'true' : 'false');
    }
    var custom = isCustom();
    var gear = $('btnSettings');
    gear.classList.toggle('dirty', custom);
    gear.title = custom ? '格式化选项（已改动）' : '格式化选项';
  }

  function touch() { cfg.preset = ''; save(); applyCfgToUi(); run(); }

  $('langSeg').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-lang]');
    if (!b || b.dataset.lang === cfg.lang) return;
    var prev = cfg.lang;
    var wasSample = srcEl.value === SAMPLES[prev];
    cfg.lang = b.dataset.lang;
    cfg.preset = '';
    if (wasSample) srcEl.value = SAMPLES[cfg.lang];
    save();
    applyCfgToUi();
    run();
  });

  $('optPreset').addEventListener('change', function () {
    var p = null;
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === this.value) p = PRESETS[i];
    if (!p) { cfg.preset = ''; save(); applyCfgToUi(); return; }
    var o = p.opts;
    for (var k in o) {
      if (k === 'indent' || k === 'width' || k === 'blank') cfg[k][cfg.lang] = o[k];
      else cfg[k] = o[k];
    }
    cfg.preset = p.id;
    save(); applyCfgToUi(); run();
  });

  $('optIndent').addEventListener('change', function () {
    if (this.value === 'tab') cfg.useTab = true;
    else { cfg.useTab = false; cfg.indent[cfg.lang] = parseInt(this.value, 10); }
    touch();
  });
  $('optBrace').addEventListener('change', function () { cfg.brace = this.value; touch(); });
  $('optElse').addEventListener('change', function () { cfg.elseNewline = this.value === 'newline'; touch(); });
  $('optCase').addEventListener('change', function () { cfg.caseIndent = this.value === 'indent'; touch(); });
  $('optMagic').addEventListener('change', function () { cfg.magicTrail = this.checked; touch(); });
  $('optWrap').addEventListener('change', function () { cfg.wrap = this.checked; touch(); });
  $('optUnwrap').addEventListener('change', function () { cfg.unwrap = this.checked; touch(); });
  $('optAlign').addEventListener('change', function () { cfg.align = this.checked; touch(); });
  $('optSort').addEventListener('change', function () { cfg.sortImports = this.checked; touch(); });
  $('optWidth').addEventListener('change', function () {
    var v = parseInt(this.value, 10);
    cfg.width[cfg.lang] = isNaN(v) ? cfg.width[cfg.lang] : Math.max(40, Math.min(200, v));
    touch();
  });
  $('optBlank').addEventListener('change', function () { cfg.blank[cfg.lang] = parseInt(this.value, 10); touch(); });
  $('optAuto').addEventListener('change', function () { cfg.auto = this.checked; save(); applyCfgToUi(); if (cfg.auto) run(); });

  /* ---------- 设置面板 ---------- */
  var panel = $('panel'), gear = $('btnSettings');
  function setPanel(open) {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  gear.addEventListener('click', function (ev) { ev.stopPropagation(); setPanel(panel.hidden); });
  document.addEventListener('click', function (ev) {
    if (!panel.hidden && !$('settings').contains(ev.target)) setPanel(false);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !panel.hidden) { setPanel(false); gear.focus(); }
  });

  /* ---------- 文件载入 ---------- */
  var EXT = Object.assign(Object.create(null), {
    c: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
    py: 'py', pyw: 'py', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js',
    json: 'json', jsonc: 'json'
  });
  function loadText(text, name) {
    srcEl.value = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    var ext = (name || '').split('.').pop().toLowerCase();
    if (EXT[ext] && EXT[ext] !== cfg.lang) {
      cfg.lang = EXT[ext];
      cfg.preset = '';
      save();
      applyCfgToUi();
    }
    lastLineCount = -1;
    run();
    srcEl.scrollTop = 0;
    syncScroll();
  }
  function readFile(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () { loadText(String(fr.result), file.name); };
    fr.readAsText(file);
  }
  $('btnFile').addEventListener('click', function () { $('filePicker').click(); });
  $('filePicker').addEventListener('change', function () {
    readFile(this.files && this.files[0]);
    this.value = '';
  });

  var dropEl = $('drop'), dragDepth = 0;
  window.addEventListener('dragenter', function (ev) {
    if (!ev.dataTransfer || Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') < 0) return;
    ev.preventDefault();
    dragDepth++;
    dropEl.hidden = false;
  });
  window.addEventListener('dragover', function (ev) {
    if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'Files') >= 0) ev.preventDefault();
  });
  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropEl.hidden = true;
  });
  window.addEventListener('drop', function (ev) {
    if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    readFile(ev.dataTransfer.files[0]);
  });

  /* ---------- 其它按钮与快捷键 ---------- */
  $('btnRun').addEventListener('click', run);
  $('btnClear').addEventListener('click', function () {
    srcEl.value = '';
    lastLineCount = -1;
    run();
    srcEl.focus();
  });
  $('btnSample').addEventListener('click', function () {
    srcEl.value = SAMPLES[cfg.lang];
    lastLineCount = -1;
    run();
  });

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
    return Promise.resolve();
  }
  function flash(btn, ok) {
    var old = btn.style.color;
    btn.style.color = ok ? 'var(--ok)' : 'var(--warn)';
    setTimeout(function () { btn.style.color = old; }, 700);
  }
  $('btnCopy').addEventListener('click', function () {
    copyText(outText).then(function () { flash($('btnCopy'), true); }, function () { flash($('btnCopy'), false); });
  });
  $('btnDownload').addEventListener('click', function () {
    var ext = cfg.lang === 'py' ? 'py' : cfg.lang === 'js' ? 'js' : cfg.lang === 'json' ? 'json' : 'cpp';
    var blob = new Blob([outText], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'formatted.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  srcEl.addEventListener('input', function () { paintInput(null); scheduleRun(); });
  srcEl.addEventListener('scroll', syncScroll);
  srcEl.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); run(); return; }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      var unit = cfg.useTab ? '\t' : new Array(cfg.indent[cfg.lang] + 1).join(' ');
      var s = srcEl.selectionStart, e = srcEl.selectionEnd;
      if (s === e) {
        srcEl.setRangeText(unit, s, e, 'end');
      } else {
        var text = srcEl.value;
        var lineStart = text.lastIndexOf('\n', s - 1) + 1;
        var lines = text.slice(lineStart, e).split('\n');
        if (ev.shiftKey) lines = lines.map(function (l) { return l.replace(/^[ \t]{1,4}/, ''); });
        else lines = lines.map(function (l) { return unit + l; });
        srcEl.setRangeText(lines.join('\n'), lineStart, e, 'end');
      }
      paintInput(null);
      scheduleRun();
    }
  });

  /* ---------- 启动 ---------- */
  if (!srcEl.value) srcEl.value = SAMPLES[cfg.lang];
  applyCfgToUi();
  paintInput(null);
  run();
})();

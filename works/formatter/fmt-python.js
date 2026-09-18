/* Python 格式化器
 *
 * 设计要点
 *  - 先按「逻辑行」切分（括号深度为 0、非 `\` 续行处的换行才算逻辑行结束），行内保留每个 token
 *    的源码行号，用来决定合并还是展开
 *  - 块结构用 blocks 栈：else/elif/except/finally 回到配对的父层，case 回到 match 体层
 *  - 空行策略按 black：模块级 def/class 前 2 行、嵌套 1 行、块首不留空行、else/except 前不留空行
 *  - 括号跨行：一行放得下就合并；放不下、含行内注释、或有「闭合括号被单独放一行」的尾逗号
 *    （magic trailing comma）时，按源码断点展开，续行缩进随嵌套深度递增
 *  - 语义敏感的空白（切片、字典的冒号）沿用源码写法，其余规范化为 PEP8
 */
(function (root) {
  'use strict';
  var L = root.FmtLex, LV = root.FmtLayout, SORT = root.FmtSort;

  var LIT_KW = L.setOf({ 'True': 1, 'False': 1, 'None': 1 });
  var PY_CTRL = L.setOf({
    'if': 1, 'elif': 1, 'else': 1, 'for': 1, 'while': 1, 'try': 1, 'except': 1, 'finally': 1,
    'with': 1, 'def': 1, 'class': 1, 'match': 1, 'case': 1, 'return': 1, 'yield': 1, 'assert': 1,
    'del': 1, 'raise': 1, 'import': 1, 'from': 1, 'global': 1, 'nonlocal': 1, 'pass': 1, 'break': 1,
    'continue': 1, 'lambda': 1
  });
  var DEDENT_KW = L.setOf({ 'else': 1, 'elif': 1, 'except': 1, 'finally': 1, 'case': 1 });
  var OPEN_BRACKETS = L.setOf({ '(': 1, '[': 1, '{': 1 });
  var CLOSE_BRACKETS = L.setOf({ ')': 1, ']': 1, '}': 1 });

  function normOpt(o) {
    o = o || {};
    return {
      indent: Math.max(1, Math.min(8, o.indent || 4)),
      useTab: !!o.useTab,
      maxBlank: o.maxBlank === undefined ? 2 : Math.max(0, Math.min(4, o.maxBlank)),
      width: Math.max(40, Math.min(200, o.width || 88)),
      unwrap: o.unwrap === undefined ? true : !!o.unwrap,
      magicTrail: o.magicTrail === undefined ? true : !!o.magicTrail,
      wrap: o.wrap === undefined ? true : !!o.wrap,
      align: !!o.align,
      sortImports: o.sortImports === undefined ? true : !!o.sortImports
    };
  }

  function fmtComment(t) {
    var body = t.slice(1).replace(/\s+$/, '');
    if (body === '') return '#';
    if (/^[ \t]/.test(body)) return '#' + body.replace(/^[ \t]+/, ' ');
    if (/^[A-Za-z0-9\u4e00-\u9fff]/.test(body)) return '# ' + body;
    return '#' + body;
  }

  // ---- 逻辑行切分（输入为 FmtLex.sig 过滤后的 token 流） ----
  function buildLines(S) {
    var lines = [], cur = null, depth = 0, cont = false, pending = 0;
    function flush() { if (cur && cur.items.length) lines.push(cur); cur = null; }
    for (var i = 0; i < S.length; i++) {
      var e = S[i];
      if (depth === 0 && !cont && e.nlB >= 1 && cur) { flush(); pending = Math.max(0, e.nlB - 1); }
      if (!cur) cur = { items: [], blankBefore: pending };
      pending = 0;
      if (e.k === 'cont') { cur.items.push({ k: 'cont', t: '\\', ln: e.ln }); cont = true; continue; }
      cont = false;
      if (e.k === 'op') {
        if (OPEN_BRACKETS[e.t]) depth++;
        else if (CLOSE_BRACKETS[e.t]) depth = Math.max(0, depth - 1);
      }
      cur.items.push({ k: e.k, t: e.t, ln: e.ln, spB: e.spB, spA: e.spA, col: e.col });
    }
    flush();
    return lines;
  }

  function meaningful(items) {
    return items.filter(function (x) { return x.k !== 'lc' && x.k !== 'cont'; });
  }

  function format(src, opt) {
    opt = normOpt(opt);
    if (opt.sortImports && SORT) src = SORT.sortPyImports(src);
    var lexed = L.lexPy(src);
    var lines = buildLines(L.sig(lexed.tokens));
    if (!lines.length) return { code: '', errors: lexed.errors, warnings: [] };
    var warnings = [];
    var i, k;

    // ================= 块结构 =================
    // 以源码缩进为准成栈：每层存「该层块体的源码缩进」，行层级 = 栈深。
    // 这样 else/elif/except/finally/case 与普通语句收尾都自然归位，不依赖关键字配对。
    var bodyIndents = [], kinds = [], pendingBlock = false, pendingKind = '', pendingSrcIndent = 0;
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i], items = ln.items, m = meaningful(items);
      ln.commentOnly = m.length === 0;
      ln.head = m.length ? (m[0].t === 'async' && m[1] ? m[1].t : m[0].t) : '';
      var last = m.length ? m[m.length - 1] : null;
      ln.endsColon = !!(last && last.k === 'op' && last.t === ':');
      ln.blockOpened = false;

      var si = items[0] ? items[0].col : 0;
      ln.closedDefLevel = -1;
      var poppedKind = null;
      while (bodyIndents.length && si < bodyIndents[bodyIndents.length - 1]) {
        bodyIndents.pop();
        var pk = kinds.pop();
        poppedKind = pk;
        if (pk === 'def' || pk === 'class') ln.closedDefLevel = bodyIndents.length;
      }
      var refIndent = bodyIndents.length ? bodyIndents[bodyIndents.length - 1] : 0;
      var deeper = si > refIndent;

      if (ln.commentOnly) {
        // 注释行不参与结构：只在源码缩进更浅时收层；若前一行刚开了块且注释缩进更深，则算进新块
        ln.indent = (pendingBlock && si > pendingSrcIndent) ? bodyIndents.length + 1 : bodyIndents.length;
        continue;
      }
      if (pendingBlock) {
        if (deeper) { bodyIndents.push(si); kinds.push(pendingKind); }
        else warnings.push('第 ' + items[0].ln + ' 行：块首未缩进');
        pendingBlock = false;
      } else if (deeper) {
        warnings.push('第 ' + items[0].ln + ' 行：缩进层级意外加深');
      }
      if (DEDENT_KW[ln.head]) {
        var enclosing = poppedKind !== null ? poppedKind : (bodyIndents.length ? kinds[bodyIndents.length - 1] : null);
        if (!compatible(enclosing, ln.head)) warnings.push('第 ' + items[0].ln + ' 行：' + ln.head + ' 找不到配对的块');
      }
      ln.indent = bodyIndents.length;
      if (ln.endsColon) { pendingBlock = true; pendingKind = ln.head || 'block'; pendingSrcIndent = si; ln.blockOpened = true; }
    }
    function compatible(kind, kw) {
      if (!kind) return false;
      if (kw === 'else' || kw === 'elif') return kind === 'if' || kind === 'elif' || kind === 'else';
      if (kw === 'except' || kw === 'finally') return kind === 'try' || kind === 'except' || kind === 'finally';
      if (kw === 'case') return kind === 'match' || kind === 'case';
      return true;
    }

    // ================= 空行策略 =================
    function isChain(i2) { return i2 >= 0 && (lines[i2].head === '@' || lines[i2].commentOnly); }
    function chainStart(i2) {
      var j = i2;
      while (j > 0 && lines[j - 1].indent === lines[i2].indent && isChain(j - 1)) j--;
      return j;
    }
    function chainHasDef(i2) {
      var j = chainStart(i2), end = lines[i2].indent;
      while (j < lines.length && lines[j].indent === end) {
        if (lines[j].head === 'def' || lines[j].head === 'class') return true;
        if (lines[j].openedBlock || !isChain(j)) return false;
        j++;
      }
      return false;
    }
    for (i = 0; i < lines.length; i++) {
      var L0 = lines[i];
      var cap = L0.indent === 0 ? Math.min(2, opt.maxBlank) : Math.min(1, opt.maxBlank);
      var want;
      if (i === 0) want = 0;
      else if (DEDENT_KW[L0.head]) want = 0;
      else if (lines[i - 1].blockOpened) want = 0;
      else if (i === chainStart(i) && chainHasDef(i)) want = L0.indent === 0 ? Math.min(2, opt.maxBlank) : Math.min(1, opt.maxBlank);
      else want = Math.min(L0.blankBefore, cap);
      // def/class 体结束后留空行（PEP8：顶层 2 行、嵌套 1 行）
      if (L0.closedDefLevel >= 0 && !DEDENT_KW[L0.head]) {
        want = Math.max(want, L0.closedDefLevel === 0 ? Math.min(2, opt.maxBlank) : Math.min(1, opt.maxBlank));
      }
      L0.blank = want;
    }

    // ================= 渲染 =================
    function pad(l) { return opt.useTab ? new Array(l + 1).join('\t') : new Array(l * opt.indent + 1).join(' '); }

    function unaryAt(items, k2) {
      var p = items[k2 - 1];
      if (!p) return true;
      if (p.k === 'op') return !(p.t === ')' || p.t === ']' || p.t === '}');
      if (p.k === 'id') return !!L.PY_KW[p.t] && !LIT_KW[p.t];
      return false;
    }

    // dep/top：item 之前的括号深度与最内层左括号
    function depthMaps(items, dep, top) {
      var st = [];
      for (var k2 = 0; k2 < items.length; k2++) {
        dep[k2] = st.length;
        top[k2] = st.length ? st[st.length - 1] : '';
        if (items[k2].k === 'op') {
          if (OPEN_BRACKETS[items[k2].t]) st.push(items[k2].t);
          else if (CLOSE_BRACKETS[items[k2].t]) st.pop();
        }
      }
    }

    // 括号内的 `=`：默认紧贴（关键字实参/默认值），但带类型注解的参数按 black 加空格
    function eqSpaced(items, dep, kk) {
      var d = dep[kk];
      if (d === 0) return true;
      for (var j = kk - 1; j >= 0; j--) {
        if (items[j].k !== 'op') continue;
        if (items[j].t === ',') return false;
        if (items[j].t === ':') return true;
        if (OPEN_BRACKETS[items[j].t] && dep[j] < d) return false;
      }
      return false;
    }

    function spaceBefore(items, k2, dep, top) {
      var it = items[k2], p = items[k2 - 1];
      if (!p || p.k === 'cont') return '';
      var t = it.t, pt = p.t;
      if (CLOSE_BRACKETS[t] || t === ',' || t === ';') return '';
      if (OPEN_BRACKETS[pt]) return '';
      if (pt === 'from' && t === '.') return ' ';      // from .mod / from ..pkg
      if (t === '.' || pt === '.') return '';
      if (OPEN_BRACKETS[t]) {
        if (CLOSE_BRACKETS[pt]) return '';
        if (p.k === 'id' && !L.PY_KW[pt]) return '';
        return ' ';
      }
      if (t === ':') {
        if (dep[k2] > 0) {
          if (top[k2] === '[') return it.spB ? ' ' : '';   // 切片沿用源码写法
          return '';
        }
        return '';
      }
      if (pt === ':') {
        if (dep[k2] > 0) {
          if (top[k2] === '[') return it.spB ? ' ' : '';
          return ' ';                                      // 字典 / 关键字参数 / 注解
        }
        return ' ';
      }
      if (t === '=') return eqSpaced(items, dep, k2) ? ' ' : '';
      if (pt === '=') return eqSpaced(items, dep, k2 - 1) ? ' ' : '';
      if (t === '*' || t === '**' || t === '-' || t === '+' || t === '~') {
        if (unaryAt(items, k2)) return OPEN_BRACKETS[pt] ? '' : ' ';
        return ' ';
      }
      if (pt === '*' || pt === '**' || pt === '-' || pt === '+' || pt === '~') {
        return unaryAt(items, k2 - 1) ? '' : ' ';
      }
      if (t === '@') return k2 === 0 ? '' : ' ';
      if (pt === '@') return k2 - 1 === 0 ? '' : ' ';
      return ' ';
    }

    function textOf(items, dep, top, skipLead) {
      var s = '';
      for (var k2 = 0; k2 < items.length; k2++) {
        var it = items[k2];
        if (it.k === 'cont') { s += (k2 > 0 ? ' ' : '') + '\\'; continue; }
        if (it.k === 'lc') { s += (k2 > 0 ? '  ' : '') + fmtComment(it.t); continue; }
        s += (k2 === 0 && skipLead ? '' : spaceBefore(items, k2, dep, top)) + it.t;
      }
      return s.replace(/[ \t]+$/, '');
    }
    function lineText(items, dep, top, lvl) { return pad(lvl) + textOf(items, dep, top, false); }

    // 折行：只在括号内（Python 隐式续行）的逗号/运算符处断开，depth 0 断开会产生语法错误
    function wrapChunk(items, dep, top, lvl, avail) {
      var breaks = LV.findBreaks(items, dep, LV.PY_BREAK_OPS).filter(function (i) { return dep[i] > 0; });
      if (!breaks.length || items.length < 3) return null;
      var pad0 = pad(lvl).length, padC = pad(lvl + 1).length;
      var segs = LV.wrapSegments({
        count: items.length,
        breaks: breaks,
        measure: function (a, b) {
          return (a === 0 ? pad0 : padC) + textOf(items.slice(a, b), dep.slice(a, b), top.slice(a, b), a > 0).length;
        },
        availFirst: avail,
        availCont: avail
      });
      if (segs.length < 2) return null;
      return segs.map(function (sg) {
        return {
          items: items.slice(sg.from, sg.to), dep: dep.slice(sg.from, sg.to), top: top.slice(sg.from, sg.to),
          lvl: sg.from === 0 ? lvl : lvl + 1, cont: sg.from > 0
        };
      });
    }

    // 单赋值语句里 = 所在列（不满足条件返回 -1）
    function eqColumn(items, dep, lvl) {
      var idx = -1;
      for (var k2 = 0; k2 < items.length; k2++) {
        if (items[k2].k === 'op' && items[k2].t === '=' && dep[k2] === 0) {
          if (idx >= 0) return -1;
          idx = k2;
        }
      }
      if (idx <= 0) return -1;
      var last = items[items.length - 1];
      if (last.k === 'op' && (last.t === ':' || last.t === ',' || last.t === ';')) return -1;
      var first = items[0];
      if (first.k === 'id' && PY_CTRL[first.t]) return -1;
      return pad(lvl).length + textOf(items.slice(0, idx), dep.slice(0, idx), top.slice(0, idx), false).length + (items[idx].s ? 1 : 0);
    }

    // 按源码行号断行，返回 [{lvl, from, to}]（区间作用于本 part 的 items）
    function splitRows(items, dep, baseLvl) {
      var rows = [], from = 0;
      for (var k2 = 1; k2 < items.length; k2++) {
        if (items[k2].ln !== items[k2 - 1].ln && dep[k2] > 0) {
          rows.push({ lvl: rowLvl(items, dep, from, baseLvl), from: from, to: k2 });
          from = k2;
        }
      }
      rows.push({ lvl: rowLvl(items, dep, from, baseLvl), from: from, to: items.length });
      return rows;
    }
    function rowLvl(items, dep, from, baseLvl) {
      var it = items[from];
      var isCloser = it.k === 'op' && CLOSE_BRACKETS[it.t];
      return baseLvl + Math.max(0, dep[from] - (isCloser ? 1 : 0));
    }

    function magicComma(items) {
      for (var k2 = 0; k2 + 1 < items.length; k2++) {
        if (items[k2].k === 'op' && items[k2].t === ',' && items[k2 + 1].k === 'op' &&
          CLOSE_BRACKETS[items[k2 + 1].t] && items[k2 + 1].ln > items[k2].ln) return true;
      }
      return false;
    }
    function innerComment(items) {
      for (var k2 = 0; k2 < items.length - 1; k2++) { if (items[k2].k === 'lc') return true; }
      return false;
    }
    function multiLine(items) {
      for (var k2 = 1; k2 < items.length; k2++) { if (items[k2].ln !== items[k2 - 1].ln) return true; }
      return false;
    }

    var out = [];
    function push(text, lvl, cont, items, dep, top) {
      var eq = (opt.align && !cont && items) ? eqColumn(items, dep, lvl) : -1;
      out.push({ t: text, lv: lvl, cont: !!cont, eq: eq });
    }
    // 一个 part 先按「整行 / 源码断点」决定形状，再对仍超宽的行按括号内断点折行
    function emitChunk(items, dep, top, lvl, isCont) {
      var text = lineText(items, dep, top, lvl);
      var forceExplode = innerComment(items) || (!opt.unwrap && multiLine(items)) || (opt.unwrap && opt.magicTrail && magicComma(items));
      if (text.length > opt.width || forceExplode) {
        var wrapped = opt.wrap ? wrapChunk(items, dep, top, lvl, opt.width) : null;
        if (wrapped) {
          for (var w = 0; w < wrapped.length; w++) {
            var c = wrapped[w];
            push(lineText(c.items, c.dep, c.top, c.lvl), c.lvl, c.cont, c.items, c.dep, c.top);
          }
          return;
        }
        if (multiLine(items) && forceExplode) {
          var rows = splitRows(items, dep, lvl);
          for (var r = 0; r < rows.length; r++) {
            var a = rows[r].from, b2 = rows[r].to;
            var ri = items.slice(a, b2), rd = dep.slice(a, b2), rt = top.slice(a, b2);
            var rw = opt.wrap ? wrapChunk(ri, rd, rt, rows[r].lvl, opt.width) : null;
            if (rw) {
              for (var w2 = 0; w2 < rw.length; w2++) {
                var c2 = rw[w2];
                push(lineText(c2.items, c2.dep, c2.top, c2.lvl), c2.lvl, c2.cont, c2.items, c2.dep, c2.top);
              }
            } else {
              push(lineText(ri, rd, rt, rows[r].lvl), rows[r].lvl, r > 0, ri, rd, rt);
            }
          }
          return;
        }
      }
      push(text, lvl, isCont, items, dep, top);
    }
    for (i = 0; i < lines.length; i++) {
      var ln2 = lines[i];
      for (k = 0; k < ln2.blank; k++) out.push({ t: '', lv: 0, cont: false, eq: -1 });
      var parts = [], acc = [];
      for (k = 0; k < ln2.items.length; k++) {
        acc.push(ln2.items[k]);
        if (ln2.items[k].k === 'cont') { parts.push(acc); acc = []; }
      }
      parts.push(acc);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        if (!part.length) continue;
        var lvl = p === 0 ? ln2.indent : ln2.indent + 1;
        var dep = [], top = [];
        depthMaps(part, dep, top);
        emitChunk(part, dep, top, lvl, p > 0);
      }
    }

    if (opt.align) LV.alignRows(out);
    while (out.length && out[out.length - 1].t.trim() === '') out.pop();
    while (out.length && out[0].t.trim() === '') out.shift();
    var res = [];
    for (i = 0; i < out.length; i++) res.push(out[i].t);
    return { code: res.length ? res.join('\n') + '\n' : '', errors: lexed.errors, warnings: warnings };
  }

  root.FmtPy = { format: format };
})(typeof window !== 'undefined' ? window : globalThis);

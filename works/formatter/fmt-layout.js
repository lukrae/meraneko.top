/* 排版后处理（C++ / Python / JS / JSON 共用）
 *
 *  - 折行：贪心填充。只在最浅一层的逗号（其次是最浅一层的二元运算符）之后断开；
 *    字符串、注释、宏不参与断点，找不到断点就保持长行（宁长不乱断）
 *  - 对齐：连续的同缩进「单赋值语句」把 = 竖直对齐；空行、注释行、折行续行都会切断这一组
 */
(function (root) {
  'use strict';
  var L = root.FmtLex;

  var OPEN = L.setOf({ '(': 1, '[': 1, '{': 1 });
  var CLOSE = L.setOf({ ')': 1, ']': 1, '}': 1 });

  // 每项「之前」的括号深度（只对 op 类 token 计括号，避免字符串里的括号误判）
  function depths(items) {
    var dep = [], d = 0;
    for (var i = 0; i < items.length; i++) {
      dep.push(d);
      if (items[i].k === 'op') {
        if (OPEN[items[i].t]) d++;
        else if (CLOSE[items[i].t]) d = Math.max(0, d - 1);
      }
    }
    return dep;
  }

  // 断点候选：优先最浅层的逗号；没有逗号时用最浅层的二元运算符（断在运算符之后）
  function findBreaks(items, dep, opSet) {
    var commas = [], ops = [], i, d;
    for (i = 0; i < items.length; i++) {
      if (items[i].k !== 'op' || i === 0) continue;
      if (items[i].t === ',') commas.push(i);
      else if (opSet[items[i].t]) ops.push(i);
    }
    function shallowest(list) {
      if (!list.length) return [];
      var min = Infinity;
      for (var j = 0; j < list.length; j++) min = Math.min(min, dep[list[j]]);
      return list.filter(function (j) { return dep[j] === min; });
    }
    var picked = shallowest(commas);
    return picked.length ? picked : shallowest(ops);
  }

  // 贪心折行：measure(from, to) 返回该段渲染后的字符宽度
  function wrapSegments(o) {
    var count = o.count, breaks = o.breaks, measure = o.measure, avail = o.availFirst;
    var segs = [], from = 0, guard = 0;
    while (from < count && guard++ < 200) {
      if (measure(from, count) <= avail) { segs.push({ from: from, to: count }); break; }
      var best = -1;
      for (var b = 0; b < breaks.length; b++) {
        var i = breaks[b];
        if (i < from) continue;
        if (measure(from, i + 1) <= avail) best = i;
        else break;
      }
      if (best < 0) {
        for (b = 0; b < breaks.length; b++) { if (breaks[b] > from) { best = breaks[b]; break; } }
        if (best < 0) { segs.push({ from: from, to: count }); break; }
      }
      segs.push({ from: from, to: best + 1 });
      from = best + 1;
      avail = o.availCont;
    }
    return segs;
  }

  // 连续赋值对齐：rows = [{ t, lv, eq, cont }]，eq 为 = 所在列（-1 表示不参与），就地改写 t
  function alignRows(rows) {
    var run = [];
    function flush() {
      if (run.length >= 2) {
        var max = 0;
        for (var i = 0; i < run.length; i++) max = Math.max(max, run[i].eq);
        for (i = 0; i < run.length; i++) {
          var r = run[i];
          if (r.eq < max) {
            r.t = r.t.slice(0, r.eq) + new Array(max - r.eq + 1).join(' ') + r.t.slice(r.eq);
            r.eq = max;
          }
        }
      }
      run = [];
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.cont || r.eq < 0 || r.t.trim() === '') { flush(); continue; }
      if (run.length && r.lv !== run[0].lv) flush();
      run.push(r);
    }
    flush();
    return rows;
  }

  var CPP_BREAK_OPS = L.setOf({
    '&&': 1, '||': 1, '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '=': 1, '+=': 1, '-=': 1, '==': 1, '!=': 1,
    '<': 1, '>': 1, '<=': 1, '>=': 1, '<<': 1, '>>': 1, '|': 1, '&': 1, '^': 1, '?': 1, ':': 1
  });
  var PY_BREAK_OPS = L.setOf({
    'and': 1, 'or': 1, '+': 1, '-': 1, '*': 1, '/': 1, '//': 1, '%': 1, '**': 1, '==': 1, '!=': 1,
    '<': 1, '>': 1, '<=': 1, '>=': 1, 'in': 1, 'is': 1, '|': 1, '&': 1, '^': 1, '=': 1, 'if': 1, 'else': 1
  });
  var JS_BREAK_OPS = L.setOf({
    '&&': 1, '||': 1, '??': 1, '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '===': 1, '!==': 1, '==': 1, '!=': 1,
    '<': 1, '>': 1, '<=': 1, '>=': 1, '=': 1, '=>': 1, '?': 1, ':': 1
  });

  root.FmtLayout = {
    depths: depths,
    findBreaks: findBreaks,
    wrapSegments: wrapSegments,
    alignRows: alignRows,
    CPP_BREAK_OPS: CPP_BREAK_OPS,
    PY_BREAK_OPS: PY_BREAK_OPS,
    JS_BREAK_OPS: JS_BREAK_OPS
  };
})(typeof window !== 'undefined' ? window : globalThis);

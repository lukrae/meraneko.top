/* 源码级排序预处理器
 *
 *  - C++：#include 连续块内排序（引号头文件在前、尖括号在后，按目标字典序）。
 *    任何非 include 行（含 #if / #endif / 空行）都会切断块，所以条件编译里的 include 不会被搬到条件外。
 *  - Python：连续的顶层 import 块重新分组（__future__ / 标准库 / 三方 / 相对导入），
 *    组内 "import x" 在 "from x import y" 之前，各自按模块名字典序；组间空一行。
 *    空行切断块，紧跟在 import 后面的独立注释行留在原地（不参与搬运）。
 *    多行 import（括号续行）整体搬运。
 */
(function (root) {
  'use strict';
  var L = root.FmtLex;

  /* ---------------- C++ ---------------- */
  var INC_RE = /^[ \t]*#[ \t]*include[ \t]*[<"]/;

  function incKey(l) {
    var m = /#[ \t]*include[ \t]*([<"][^>"]*[>"])/.exec(l);
    return m ? m[1] : l.trim();
  }

  function sortCppIncludes(src) {
    var lines = src.split('\n'), i = 0;
    while (i < lines.length) {
      if (!INC_RE.test(lines[i])) { i++; continue; }
      var start = i;
      while (i < lines.length && INC_RE.test(lines[i])) i++;
      if (i - start < 2) continue;
      var run = lines.slice(start, i);
      run.sort(function (a, b) {
        var ka = incKey(a), kb = incKey(b);
        if (ka === kb) return a < b ? -1 : (a > b ? 1 : 0);
        return ka < kb ? -1 : 1;
      });
      for (var j = 0; j < run.length; j++) lines[start + j] = run[j];
    }
    return lines.join('\n');
  }

  /* ---------------- Python ---------------- */
  var PY_STDLIB = L.set(('abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd ' +
    'code codecs codeop collections colorsys compileall concurrent configparser contextlib copy copyreg csv ctypes ' +
    'dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp ' +
    'fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac ' +
    'html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma ' +
    'mailbox marshal math mimetypes mmap modulefinder multiprocessing netrc ntpath numbers operator optparse os ' +
    'pathlib pdb pickle pickletools pkgutil platform plistlib poplib posixpath pprint profile pstats pty py_compile ' +
    'pydoc queue quopri random re readline reprlib resource select selectors shelve shlex shutil signal site smtplib ' +
    'sndhdr socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig ' +
    'tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize trace traceback tracemalloc ' +
    'tty turtle types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg wsgiref ' +
    'xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread'.split(' '));

  // 逻辑行切分：返回 { s, e, col, first, toks, text }，s/e 为 1 起始的源码行号（含）
  function logicalSpans(src) {
    var toks = L.lexPy(src).tokens, out = [], cur = null, depth = 0, cont = false, col = 0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.k === 'nl') { if (depth === 0 && !cont && cur) { cur.e = cur.lastLn; out.push(cur); cur = null; } col = 0; continue; }
      if (t.k === 'ws') { col += t.t.length; continue; }
      if (t.k === 'cont') { cont = true; continue; }
      cont = false;
      if (!cur) cur = { s: t.ln, lastLn: t.ln, col: col, first: { k: t.k, t: t.t }, toks: [] };
      cur.lastLn = t.ln;
      if (t.k !== 'lc') cur.toks.push({ k: t.k, t: t.t });
      if (t.k === 'op') {
        if (t.t === '(' || t.t === '[' || t.t === '{') depth++;
        else if (t.t === ')' || t.t === ']' || t.t === '}') depth = Math.max(0, depth - 1);
      }
    }
    if (cur) { cur.e = cur.lastLn; out.push(cur); }
    return out;
  }

  var FROM_RE = /^from\s*([.\w]+)\s*import\b/;
  var IMPORT_RE = /^import\s*([.\w]+)/;

  function moduleOf(plain) {
    var m = FROM_RE.exec(plain) || IMPORT_RE.exec(plain);
    return m ? m[1] : '';
  }
  function groupOf(plain, mod) {
    if (/^from\s+__future__\b/.test(plain)) return 0;
    if (mod.charAt(0) === '.') return 3;
    return PY_STDLIB[mod.split('.')[0]] ? 1 : 2;
  }

  function sortPyImports(src) {
    var lines = src.split('\n'), spans = logicalSpans(src);
    // 按行号找相邻（无空行）的 import / 注释 序列
    var i = 0, blocks = [];
    while (i < spans.length) {
      if (spans[i].first.k !== 'id' || (spans[i].first.t !== 'import' && spans[i].first.t !== 'from') || spans[i].col !== 0) { i++; continue; }
      var block = [spans[i]];
      var j = i + 1;
      while (j < spans.length && spans[j].s - block[block.length - 1].e <= 1 && spans[j].col === 0 &&
        (spans[j].first.k === 'lc' || (spans[j].first.k === 'id' && (spans[j].first.t === 'import' || spans[j].first.t === 'from')))) {
        block.push(spans[j]);
        j++;
      }
      i = j;
      // 末尾的独立注释行留在原地
      while (block.length && block[block.length - 1].first.k === 'lc') block.pop();
      var nImp = block.filter(function (b) { return b.first.k !== 'lc'; }).length;
      if (nImp >= 2) blocks.push(block);
    }
    for (var b = blocks.length - 1; b >= 0; b--) {
      var blk = blocks[b];
      var startLn = blk[0].s, endLn = blk[blk.length - 1].e;
      // 组装条目：注释行附到其后的 import
      var entries = [], pend = [];
      blk.forEach(function (sp) {
        if (sp.first.k === 'lc') { pend.push(lines.slice(sp.s - 1, sp.e).join('\n')); return; }
        var text = lines.slice(sp.s - 1, sp.e).join('\n');
        var plain = L.canonImport(sp.toks, null);
        var mod = moduleOf(plain);
        entries.push({
          text: text, plain: plain, comments: pend, mod: mod,
          group: groupOf(plain, mod),
          from: sp.first.t === 'from' ? 1 : 0,
          key: mod.toLowerCase() + '|' + plain.toLowerCase() + '|' + plain
        });
        pend = [];
      });
      var groups = [[], [], [], []];
      entries.forEach(function (e) { groups[e.group].push(e); });
      groups.forEach(function (g) {
        g.sort(function (a, c) { return a.from !== c.from ? a.from - c.from : (a.key < c.key ? -1 : (a.key > c.key ? 1 : 0)); });
      });
      var outLines = [];
      groups.forEach(function (g) {
        if (!g.length) return;
        if (outLines.length) outLines.push('');
        g.forEach(function (e) {
          e.comments.forEach(function (c) { outLines.push(c); });
          outLines.push(e.text);
        });
      });
      var repl = outLines.join('\n').split('\n');
      Array.prototype.splice.apply(lines, [startLn - 1, endLn - startLn + 1].concat(repl));
    }
    return lines.join('\n');
  }

  root.FmtSort = { sortCppIncludes: sortCppIncludes, sortPyImports: sortPyImports, logicalSpans: logicalSpans };
})(typeof window !== 'undefined' ? window : globalThis);

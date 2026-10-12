/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The script-facing runtime, evaluated inside QuickJS before the script.
 *
 * It evaluates to a function that takes the run's config (JSON text), defines
 * the workflow globals, and returns `{ receive, watch }` — handles only the
 * host process holds. Its single way out is the `__wfPost` host function,
 * captured and deleted from the global before the script can see it; every
 * message it posts is a JSON string, and everything it receives is parsed
 * from one.
 *
 * Builtins it depends on are captured up front and called through
 * `Reflect.apply`, so a script that overrides `Promise.prototype.then`, array
 * methods or iterators only changes its own code's behaviour, not the
 * runtime's bookkeeping. NOTE: this is a template literal — no backticks or
 * `${` anywhere inside it.
 */
export const WORKFLOW_GUEST_PRELUDE = `(function (configJson) {
  'use strict';
  var post = globalThis.__wfPost;
  delete globalThis.__wfPost;
  var removed = ['process', 'require', 'module', 'Buffer', 'fetch',
    'XMLHttpRequest', 'WebSocket', 'setTimeout', 'clearTimeout', 'setInterval',
    'setImmediate', 'queueMicrotask', 'Atomics', 'SharedArrayBuffer',
    'WebAssembly'];
  for (var r = 0; r < removed.length; r++) {
    try { delete globalThis[removed[r]]; } catch (e) {}
  }

  var apply = Reflect.apply;
  var NativePromise = Promise;
  var nativeThen = Promise.prototype.then;
  var nativeResolve = Promise.resolve;
  var nativeAll = Promise.all;
  var nativeRace = Promise.race;
  var nativeAny = Promise.any;
  var parseJson = JSON.parse;
  var stringifyJson = JSON.stringify;
  var isArray = Array.isArray;
  var objectKeys = Object.keys;
  var objectCreate = Object.create;
  var defineProperty = Object.defineProperty;
  var getOwnPropertyNames = Object.getOwnPropertyNames;
  var objectToString = Object.prototype.toString;
  var functionToString = Function.prototype.toString;
  var stringIndexOf = String.prototype.indexOf;
  var mapForEach = Map.prototype.forEach;
  var mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  var setForEach = Set.prototype.forEach;
  var setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
  var weakMapGet = WeakMap.prototype.get;
  var weakMapSet = WeakMap.prototype.set;
  var WeakMapCtor = WeakMap;
  var StringCtor = String;
  var ErrorCtor = Error;
  var isFiniteNumber = Number.isFinite;

  var config = parseJson(configJson);

  function message(type) {
    var m = objectCreate(null);
    m.type = type;
    return m;
  }
  function send(m) {
    post(stringifyJson(m));
  }
  function then(promise, onFulfilled, onRejected) {
    return apply(nativeThen, promise, [onFulfilled, onRejected]);
  }
  function resolved(value) {
    return apply(nativeResolve, NativePromise, [value]);
  }
  function readFlag(value, name) {
    try {
      return !!(value && value[name]);
    } catch (e) {
      return false;
    }
  }
  function messageOf(value) {
    try {
      return value && value.message != null
        ? StringCtor(value.message)
        : StringCtor(value);
    } catch (e) {
      return '[unserializable rejection value]';
    }
  }
  function nameOf(value) {
    try {
      return value && typeof value.name === 'string' ? value.name : undefined;
    } catch (e) {
      return undefined;
    }
  }
  function debug(text) {
    var m = message('debug');
    m.message = text;
    send(m);
  }

  // --- Logs ---
  // The host caps the log at maxLogLines plus a truncation marker, and its
  // count never trails this one, so lines past that point are not sent.
  var postedLogLines = 0;
  function pushLog(line) {
    if (postedLogLines > config.maxLogLines) return;
    postedLogLines++;
    var m = message('log');
    m.line = line;
    send(m);
  }

  // --- Dependency contexts ---
  // Every agent()/workflow() request names the fan-out branch that issued it
  // so the host can keep each branch's dependency tail. A call is attributed
  // to the branch whose synchronous code issued it; after an await, to the
  // branch of the request whose settlement resumed it (the host settles one
  // request per job burst). See SandboxOptions.dependencies.
  var ROOT_CONTEXT = objectCreate(null);
  ROOT_CONTEXT.group = 0;
  ROOT_CONTEXT.branch = 0;
  var currentContext = ROOT_CONTEXT;
  var nextGroup = 1;
  function inContext(context, fn) {
    var saved = currentContext;
    currentContext = context;
    try {
      return fn();
    } finally {
      currentContext = saved;
    }
  }

  // --- Requests to the host ---
  var nextRequestId = 1;
  var pending = objectCreate(null);
  var runAborted = false;
  var budgetState = config.budget;
  function request(m) {
    var id = nextRequestId++;
    var entry = objectCreate(null);
    entry.context = currentContext;
    var promise = new NativePromise(function (resolve, reject) {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    m.id = id;
    m.group = currentContext.group;
    m.branch = currentContext.branch;
    send(m);
    pending[id] = entry;
    return promise;
  }

  // --- Unconsumed-rejection mirror ---
  // A dispatch refused at the entry gate (budget / agent cap) or failing
  // mid-run reaches no other surface when the script never consumes its
  // promise, so such rejections are recorded and mirrored into the run log
  // when the run settles. A later consumption clears the record; a root the
  // script attached a rejection handler to is never mirrored.
  var unconsumedRoots = objectCreate(null);
  var unconsumedRejections = objectCreate(null);
  var nextUnconsumedId = 1;
  var unconsumedSettled = false;
  var mirroredKeys = objectCreate(null);
  function registerRoot() {
    var id = nextUnconsumedId++;
    var state = objectCreate(null);
    state.rejectionHandled = false;
    state.adoptedOut = false;
    unconsumedRoots[id] = state;
    return id;
  }
  function rootState(id) {
    return typeof id === 'number' ? unconsumedRoots[id] : undefined;
  }
  function unconsumedLine(rec) {
    if (rec.dispatchFailed) {
      return rec.isRoot
        ? 'dispatch failed (result not consumed): ' + rec.msg
        : 'dispatch failed (rejection not handled): ' + rec.msg;
    }
    return 'script handler failed (rejection not handled): ' + rec.msg;
  }
  function reportUnconsumed(rootId, isRoot, dispatchFailed, msg) {
    var rec = objectCreate(null);
    rec.rootId = rootId;
    rec.isRoot = isRoot;
    rec.dispatchFailed = dispatchFailed;
    rec.msg = msg;
    if (unconsumedSettled) {
      // The script can no longer consume a rejection that lands after the
      // run settled, so it is mirrored at once.
      var state = rootState(rootId);
      if (!(state && state.rejectionHandled) &&
          !(dispatchFailed && state && state.adoptedOut)) {
        pushLog(unconsumedLine(rec));
      }
      return 0;
    }
    var id = nextUnconsumedId++;
    unconsumedRejections[id] = rec;
    return id;
  }
  // A forwarded dispatch rejection whose root was adopted (await /
  // Promise.resolve / a returned thenable) rides the adopting promise, which
  // the runtime cannot observe, so it is not mirrored: handled there it needs
  // no signal, and a forgotten one is the known gap of this mirror.
  function flushUnconsumed() {
    unconsumedSettled = true;
    var ids = objectKeys(unconsumedRejections);
    for (var i = 0; i < ids.length; i++) {
      var rec = unconsumedRejections[ids[i]];
      var state = rootState(rec.rootId);
      if (state && state.rejectionHandled) continue;
      if (rec.dispatchFailed && state && state.adoptedOut) continue;
      // One failed dispatch fanned out into N unconsumed branches is one
      // failure and surfaces as exactly one line.
      var key = rec.rootId + '\\u0000' + rec.msg;
      if (mirroredKeys[key] === true) continue;
      mirroredKeys[key] = true;
      pushLog(unconsumedLine(rec));
    }
    unconsumedRejections = objectCreate(null);
  }

  function mapDispatchError(hostErr) {
    var vmErr = new ErrorCtor(messageOf(hostErr));
    // Teardown: a rejection named AbortError, one the host marked as
    // cancellation, or any rejection once the run's abort has fired.
    if (readFlag(hostErr, 'abort') || nameOf(hostErr) === 'AbortError' ||
        runAborted) {
      vmErr.__wfAbort = true;
    }
    var name = nameOf(hostErr);
    if (readFlag(hostErr, 'runFailure') ||
        readFlag(hostErr, '__wfRunFailure') ||
        name === 'WorkflowBudgetExceededError' ||
        name === 'WorkflowAgentCapExceededError') {
      vmErr.__wfRunFailure = true;
    }
    vmErr.__wfDispatchFailed = true;
    return vmErr;
  }
  function observeDispatch(promise) {
    // Direct native-then call: routing through ObservedPromise.then would
    // mark the promise consumed and recurse the observer. The body must be
    // exception-safe on any rejection value.
    then(promise, undefined, function (err) {
      if (promise.__wfConsumed) return;
      if (readFlag(err, '__wfAbort') || runAborted) return;
      var dispatchFailed = readFlag(err, '__wfDispatchFailed');
      var errors = null;
      try {
        if (err && isArray(err.errors)) errors = err.errors;
      } catch (e) {
        errors = null;
      }
      if (!dispatchFailed && errors) {
        // Promise.any rejects with an AggregateError carrying no flags; the
        // element errors keep theirs.
        for (var i = 0; i < errors.length; i++) {
          if (readFlag(errors[i], '__wfDispatchFailed')) {
            dispatchFailed = true;
            break;
          }
        }
      }
      // An aggregate's rejection forwarded from an element whose own root
      // the script already handled is not mirrored again.
      try {
        var sourceIds = [];
        if (err && err.__wfRootId) {
          sourceIds[sourceIds.length] = err.__wfRootId;
        } else if (errors) {
          for (var j = 0; j < errors.length; j++) {
            if (errors[j] && errors[j].__wfRootId) {
              sourceIds[sourceIds.length] = errors[j].__wfRootId;
            }
          }
        }
        for (var k = 0; k < sourceIds.length; k++) {
          var source = rootState(sourceIds[k]);
          if (sourceIds[k] !== promise.__wfRootId && source &&
              source.rejectionHandled) {
            return;
          }
        }
      } catch (e) {
        // Mirror conservatively.
      }
      promise.__wfUnconsumedId = reportUnconsumed(
        promise.__wfRootId,
        promise.__wfIsRoot === true,
        dispatchFailed,
        messageOf(err),
      );
    });
  }
  // await / Promise.resolve / returning a thenable adopt an ObservedPromise
  // through its then with the adopting promise's native resolving
  // functions. Adoption consumes the result but is not a rejection handler.
  function isAdoptionAttach(handler) {
    try {
      return typeof handler === 'function' &&
        apply(stringIndexOf, apply(functionToString, handler, []),
          ['[native code]']) !== -1;
    } catch (e) {
      return false;
    }
  }
  class ObservedPromise extends NativePromise {
    then(onFulfilled, onRejected) {
      var rethrows = false;
      try {
        rethrows = !!(onRejected && onRejected.__wfRethrows);
      } catch (e) {
        rethrows = false;
      }
      this.__wfConsumed = true;
      var state = rootState(this.__wfRootId);
      if (isAdoptionAttach(onRejected)) {
        if (state) state.adoptedOut = true;
      } else if (typeof onRejected === 'function' && !rethrows) {
        if (state) state.rejectionHandled = true;
      }
      if (this.__wfUnconsumedId !== undefined) {
        delete unconsumedRejections[this.__wfUnconsumedId];
        this.__wfUnconsumedId = undefined;
      }
      var derived = apply(nativeThen, this, [onFulfilled, onRejected]);
      derived.__wfRootId = this.__wfRootId;
      observeDispatch(derived);
      return derived;
    }
    finally(onFinally) {
      // Native finally calls then with two functions, indistinguishable from
      // a real then(f, g); route through then with a marked rethrow
      // combinator so a finally-only chain stays mirrored.
      if (typeof onFinally !== 'function') {
        return this.then(undefined, undefined);
      }
      var onRethrow = function (err) {
        return then(resolved(onFinally()), function () {
          throw err;
        });
      };
      onRethrow.__wfRethrows = true;
      return this.then(function (value) {
        return then(resolved(onFinally()), function () {
          return value;
        });
      }, onRethrow);
    }
  }
  var observedThen = ObservedPromise.prototype.then;
  function observeAggregate(nativeAggregate) {
    var rootId = registerRoot();
    var observed = new ObservedPromise(function (resolve, reject) {
      then(nativeAggregate, resolve, reject);
    });
    observed.__wfRootId = rootId;
    observed.__wfIsRoot = true;
    observeDispatch(observed);
    return observed;
  }
  // A static called on a script-defined subclass must return a subclass
  // instance, so other receivers bypass observation.
  Promise.all = function (items) {
    if (this !== NativePromise) return apply(nativeAll, this, [items]);
    return observeAggregate(apply(nativeAll, this, [items]));
  };
  Promise.race = function (items) {
    if (this !== NativePromise) return apply(nativeRace, this, [items]);
    return observeAggregate(apply(nativeRace, this, [items]));
  };
  Promise.any = function (items) {
    if (this !== NativePromise) return apply(nativeAny, this, [items]);
    return observeAggregate(apply(nativeAny, this, [items]));
  };
  // Every script-facing async entry point: its promise is an observed root,
  // and every rejection reaching the script is a fresh guest Error carrying
  // the run's flags.
  function vmAsync(impl) {
    return function () {
      var args = arguments;
      var rootId = registerRoot();
      var p = new ObservedPromise(function (resolve, reject) {
        function rejectMapped(hostErr) {
          var vmErr = mapDispatchError(hostErr);
          try {
            vmErr.__wfRootId = rootId;
          } catch (e) {}
          reject(vmErr);
        }
        try {
          then(apply(impl, undefined, args), function (value) {
            resolve(value);
          }, rejectMapped);
        } catch (hostErr) {
          rejectMapped(hostErr);
        }
      });
      p.__wfRootId = rootId;
      p.__wfIsRoot = true;
      observeDispatch(p);
      return p;
    };
  }

  // --- Determinism guards ---
  var safeMath = objectCreate(null);
  var mathNames = getOwnPropertyNames(Math);
  for (var mi = 0; mi < mathNames.length; mi++) {
    if (mathNames[mi] === 'random' || mathNames[mi] === 'constructor') continue;
    safeMath[mathNames[mi]] = Math[mathNames[mi]];
  }
  safeMath.random = function () {
    throw new ErrorCtor(
      'Math.random() is unavailable in workflow scripts (breaks resume). ' +
      'For N independent samples, include the index in the agent label or prompt.'
    );
  };
  globalThis.Math = safeMath;
  var dateMsg = 'Date.now() / new Date() are unavailable in workflow ' +
    'scripts (breaks resume). Stamp results after the workflow returns, ' +
    'or pass timestamps via args.';
  var safeDate = function Date() { throw new ErrorCtor(dateMsg); };
  safeDate.now = function () { throw new ErrorCtor(dateMsg); };
  safeDate.UTC = function () { throw new ErrorCtor(dateMsg); };
  safeDate.parse = function () { throw new ErrorCtor(dateMsg); };
  Object.setPrototypeOf(safeDate, null);
  defineProperty(safeDate, 'constructor', {
    value: undefined, writable: false, configurable: false,
  });
  globalThis.Date = safeDate;

  globalThis.args = config.args === null ? undefined : parseJson(config.args);

  // --- phase / log / console ---
  globalThis.phase = function phase(title) {
    var m = message('phase');
    m.title = StringCtor(title);
    send(m);
  };
  globalThis.log = function log(msg) {
    pushLog(StringCtor(msg));
  };
  var safeConsole = objectCreate(null);
  safeConsole.log = function () {
    var line = '';
    for (var i = 0; i < arguments.length; i++) {
      line += (i === 0 ? '' : ' ') + StringCtor(arguments[i]);
    }
    pushLog(line);
  };
  safeConsole.warn = safeConsole.log;
  safeConsole.error = safeConsole.log;
  globalThis.console = safeConsole;

  // --- agent ---
  var KNOWN_AGENT_OPTS = objectCreate(null);
  var knownAgentOptNames = ['stepId', 'label', 'phase', 'schema', 'model',
    'effort', 'isolation', 'agentType', 'stallMs', 'workingDir',
    'disallowedTools', 'tools'];
  var knownAgentOptList = '';
  for (var ki = 0; ki < knownAgentOptNames.length; ki++) {
    KNOWN_AGENT_OPTS[knownAgentOptNames[ki]] = true;
    knownAgentOptList += (ki === 0 ? '' : ', ') + knownAgentOptNames[ki];
  }
  globalThis.agent = vmAsync(function (prompt, agentOpts) {
    agentOpts = agentOpts || {};
    var keys = objectKeys(agentOpts);
    for (var i = 0; i < keys.length; i++) {
      if (KNOWN_AGENT_OPTS[keys[i]] !== true) {
        throw new ErrorCtor(
          'agent({' + keys[i] + '}): unknown option. ' +
          'Known options are: ' + knownAgentOptList + '.'
        );
      }
    }
    if (agentOpts.isolation !== undefined &&
        agentOpts.isolation !== 'worktree' &&
        agentOpts.isolation !== 'remote') {
      throw new ErrorCtor(
        "agent({isolation: '" + agentOpts.isolation + "'}): unknown isolation mode. " +
        "Known modes are: 'worktree', 'remote'."
      );
    }
    // A non-number stallMs is silently dropped downstream and the default
    // watchdog applies, contradicting "0 disables the watchdog".
    if (agentOpts.stallMs !== undefined &&
        (typeof agentOpts.stallMs !== 'number' ||
         !isFiniteNumber(agentOpts.stallMs))) {
      throw new ErrorCtor('agent({stallMs}): must be a finite number of milliseconds (0 disables the watchdog).');
    }
    if (agentOpts.workingDir !== undefined) {
      if (typeof agentOpts.workingDir !== 'string' ||
          agentOpts.workingDir.trim().length === 0) {
        throw new ErrorCtor(
          'agent({workingDir}): must be a non-empty string naming an existing ' +
          'git worktree of this repository.'
        );
      }
      if (agentOpts.isolation !== undefined) {
        throw new ErrorCtor(
          'agent({workingDir, isolation}): incompatible options. workingDir ' +
          'pins the agent to a worktree you already own; isolation creates ' +
          'a fresh one and removes it afterwards. Pass one.'
        );
      }
    }
    // Only a JSON copy crosses to the host; the host validates and
    // normalizes effort, disallowedTools and tools on that copy, so a getter
    // cannot show one value here and hand another to the dispatch.
    var safeOpts;
    try {
      safeOpts = parseJson(stringifyJson(agentOpts));
    } catch (e) {
      throw new ErrorCtor(
        'agent() opts contain a non-JSON-serializable value: ' + messageOf(e)
      );
    }
    var m = message('agent');
    m.prompt = typeof prompt === 'string' ? prompt : null;
    m.opts = safeOpts;
    if (typeof agentOpts.phase === 'string' && agentOpts.phase.length > 0) {
      m.phase = agentOpts.phase;
    }
    return request(m);
  });

  // --- parallel / pipeline ---
  function findRunFailure(reason, visited) {
    if (reason === null || typeof reason !== 'object') return undefined;
    for (var v = 0; v < visited.length; v++) {
      if (visited[v] === reason) return undefined;
    }
    visited[visited.length] = reason;
    try {
      if (reason.__wfRunFailure === true) return reason;
      var errors = reason.errors;
      if (!isArray(errors)) return undefined;
      for (var i = 0; i < errors.length; i++) {
        var found = findRunFailure(errors[i], visited);
        if (found !== undefined) return found;
      }
    } catch (e) {
      return undefined;
    }
    return undefined;
  }
  function reviveInRealm(values) {
    var out = [];
    for (var i = 0; i < values.length; i++) {
      try {
        out[i] = parseJson(stringifyJson(values[i]));
      } catch (e) {
        debug('Workflow result revival failed at index ' + i + ': ' +
          messageOf(e) + '; slot set to null (non-JSON-serializable thunk return).');
        out[i] = null;
      }
    }
    return out;
  }
  // Settle every branch into a position-aligned array — errors-as-data: a
  // branch that rejects becomes null at its index. Cancellation and
  // run-level dispatch failures reject the whole batch, because no later
  // agent call can succeed under either. Each branch starts in its own
  // microtask, inside its own dependency context.
  function fanOut(branches) {
    var parentContext = currentContext;
    var count = branches.length;
    var group = nextGroup++;
    if (count > 0) {
      var fork = message('fork');
      fork.group = group;
      fork.parentGroup = parentContext.group;
      fork.parentBranch = parentContext.branch;
      send(fork);
    }
    return new NativePromise(function (resolve, reject) {
      var outcomes = [];
      var remaining = count;
      function finish() {
        var failure;
        if (runAborted) {
          failure = new ErrorCtor('Workflow run aborted.');
          failure.name = 'AbortError';
        } else {
          for (var k = 0; k < count && failure === undefined; k++) {
            if (!outcomes[k].ok) {
              failure = findRunFailure(outcomes[k].reason, []);
            }
          }
        }
        if (count > 0) {
          var join = message('join');
          join.group = group;
          join.merge = failure === undefined;
          send(join);
        }
        // What runs next continues the caller's branch.
        currentContext = parentContext;
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        var values = [];
        for (var i = 0; i < count; i++) {
          if (outcomes[i].ok) {
            values[i] = outcomes[i].value;
          } else {
            debug('Workflow thunk at index ' + i + ' rejected: ' +
              messageOf(outcomes[i].reason));
            values[i] = null;
          }
        }
        resolve(values);
      }
      if (count === 0) {
        finish();
        return;
      }
      for (var b = 0; b < count; b++) {
        (function (index) {
          var context = objectCreate(null);
          context.group = group;
          context.branch = index;
          then(then(resolved(), function () {
            return inContext(context, branches[index]);
          }), function (value) {
            var o = objectCreate(null);
            o.ok = true;
            o.value = value;
            outcomes[index] = o;
            if (--remaining === 0) finish();
          }, function (reason) {
            var o = objectCreate(null);
            o.ok = false;
            o.reason = reason;
            outcomes[index] = o;
            if (--remaining === 0) finish();
          });
        })(b);
      }
    });
  }
  var callParallel = vmAsync(function (thunks) {
    if (!isArray(thunks)) {
      throw new ErrorCtor('parallel() expects an array of thunks (functions returning promises).');
    }
    var branches = [];
    for (var i = 0; i < thunks.length; i++) {
      if (typeof thunks[i] !== 'function') {
        throw new ErrorCtor(
          'parallel() expects an array of functions, not values — wrap each ' +
          'call: parallel([() => agent(...), () => agent(...)]).'
        );
      }
      branches[i] = thunks[i];
    }
    return fanOut(branches);
  });
  globalThis.parallel = function parallel(thunks) {
    return apply(observedThen, callParallel(thunks), [reviveInRealm]);
  };
  // Run one item through every stage in order. null is the drop sentinel: a
  // stage that returns null (or throws) skips the rest of the chain.
  async function runChain(context, item, idx, stages) {
    var prev = item;
    for (var s = 0; s < stages.length; s++) {
      if (prev === null) break;
      var stage = stages[s];
      prev = await inContext(context, function () {
        return stage(prev, item, idx);
      });
    }
    return prev;
  }
  var callPipeline = vmAsync(function (items) {
    if (!isArray(items)) {
      throw new ErrorCtor('pipeline() expects an array of items as its first argument.');
    }
    var stages = [];
    for (var s = 1; s < arguments.length; s++) {
      if (typeof arguments[s] !== 'function') {
        throw new ErrorCtor(
          'pipeline() stages must be functions: ' +
          'pipeline(items, item => ..., result => ...).'
        );
      }
      stages[s - 1] = arguments[s];
    }
    var branches = [];
    for (var i = 0; i < items.length; i++) {
      (function (item, idx) {
        branches[idx] = function () {
          return runChain(currentContext, item, idx, stages);
        };
      })(items[i], i);
    }
    return fanOut(branches);
  });
  globalThis.pipeline = function pipeline() {
    return apply(observedThen, apply(callPipeline, undefined, arguments),
      [reviveInRealm]);
  };

  // --- workflow (nested, single-level) ---
  // The host wires workflow() only at the top level, so a nested script's
  // workflow() lands in the throwing stub — the single-level limit.
  if (config.workflow) {
    var callWorkflow = vmAsync(function (nameOrRef, wfArgs, wfOpts) {
      var badOpts = wfOpts !== undefined && (wfOpts === null ||
        typeof wfOpts !== 'object' || isArray(wfOpts));
      if (!badOpts && wfOpts !== undefined) {
        var optKeys = objectKeys(wfOpts);
        for (var o = 0; o < optKeys.length; o++) {
          if (optKeys[o] !== 'stepId') badOpts = true;
        }
      }
      if (badOpts) {
        throw new ErrorCtor('workflow() options must be an object containing only stepId.');
      }
      var stepId = wfOpts === undefined ? undefined : wfOpts.stepId;
      var m = message('workflow');
      try {
        m.ref = nameOrRef === undefined
          ? undefined : parseJson(stringifyJson(nameOrRef));
        m.args = wfArgs === undefined
          ? undefined : parseJson(stringifyJson(wfArgs));
      } catch (e) {
        throw new ErrorCtor(
          'workflow() received a non-JSON-serializable argument: ' + messageOf(e)
        );
      }
      if (stepId !== undefined) {
        m.stepId = typeof stepId === 'string' ? stepId : null;
      }
      return request(m);
    });
    globalThis.workflow = function workflow(nameOrRef, wfArgs, wfOpts) {
      return callWorkflow(nameOrRef, wfArgs, wfOpts);
    };
  } else {
    globalThis.workflow = function workflow() {
      return new NativePromise(function (_, reject) {
        reject(new ErrorCtor(
          'workflow() is unavailable here. Either this sandbox was created ' +
          'without a saved-workflow resolver, or this script is already ' +
          'running as a nested workflow — workflow() nesting is limited to ' +
          'a single level (a workflow cannot call another workflow that ' +
          'itself calls workflow()).'
        ));
      });
    };
  }

  // --- budget ---
  // spent()/remaining() read the snapshot the host sends with every
  // settlement, which is current whenever the script is running.
  var safeBudget = objectCreate(null);
  defineProperty(safeBudget, 'total', {
    value: config.budget ? config.budget.total : null,
    writable: false, configurable: false,
  });
  defineProperty(safeBudget, 'spent', {
    value: config.budget
      ? function spent() { return budgetState.spent; }
      : function spent() {
          throw new ErrorCtor('budget.spent() is not supported in P1. Token tracking is scheduled for P5.');
        },
    writable: false, configurable: false,
  });
  defineProperty(safeBudget, 'remaining', {
    value: config.budget
      ? function remaining() {
          return budgetState.remaining === null ? Infinity : budgetState.remaining;
        }
      : function remaining() {
          throw new ErrorCtor('budget.remaining() is not supported in P1. Token tracking is scheduled for P5.');
        },
    writable: false, configurable: false,
  });
  globalThis.budget = safeBudget;

  // --- Result encoding ---
  // The return value crosses as tagged JSON so the host can rebuild what its
  // result formatting distinguishes — Error, Map, Set, BigInt, undefined,
  // shared and circular references, and a property whose getter throws —
  // from data alone. Primitives other than those are plain JSON.
  function encodeResult(root) {
    var ids = new WeakMapCtor();
    var nextId = 0;
    function isMap(value) {
      try { apply(mapSize, value, []); return true; } catch (e) { return false; }
    }
    function isSet(value) {
      try { apply(setSize, value, []); return true; } catch (e) { return false; }
    }
    function read(holder, key) {
      try {
        return encode(holder[key], key, 0);
      } catch (e) {
        return ['x', messageOf(e)];
      }
    }
    function encode(value, key, depth) {
      if (depth > 1000) throw new ErrorCtor('the result is nested too deeply');
      if ((typeof value === 'object' && value !== null) ||
          typeof value === 'bigint') {
        var toJSON = value.toJSON;
        if (typeof toJSON === 'function') value = apply(toJSON, value, [key]);
      }
      if (value === null || typeof value === 'string' ||
          typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'number') {
        return isFiniteNumber(value) ? value : ['n', StringCtor(value)];
      }
      if (typeof value === 'bigint') return ['b', StringCtor(value)];
      if (typeof value !== 'object') return ['u'];
      var known = apply(weakMapGet, ids, [value]);
      if (known !== undefined) return ['r', known];
      var id = nextId++;
      apply(weakMapSet, ids, [value, id]);
      var items = [];
      if (apply(objectToString, value, []) === '[object Error]') {
        var errorMessage;
        try {
          errorMessage = value.message == null ? '' : StringCtor(value.message);
        } catch (e) {
          errorMessage = '';
        }
        return ['e', id, nameOf(value) === undefined ? null : nameOf(value), errorMessage];
      }
      if (isMap(value)) {
        apply(mapForEach, value, [function (v, k) {
          items[items.length] = [encode(k, '', depth + 1), encode(v, '', depth + 1)];
        }]);
        return ['m', id, items];
      }
      if (isSet(value)) {
        apply(setForEach, value, [function (v) {
          items[items.length] = encode(v, '', depth + 1);
        }]);
        return ['s', id, items];
      }
      if (isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          try {
            items[i] = encode(value[i], StringCtor(i), depth + 1);
          } catch (e) {
            items[i] = ['x', messageOf(e)];
          }
        }
        return ['a', id, items];
      }
      var keys = objectKeys(value);
      for (var k = 0; k < keys.length; k++) {
        var entry;
        try {
          entry = encode(value[keys[k]], keys[k], depth + 1);
        } catch (e) {
          entry = ['x', messageOf(e)];
        }
        items[k] = [keys[k], entry];
      }
      return ['o', id, items];
    }
    return read({ '': root }, '');
  }
  function errorData(error) {
    var data = objectCreate(null);
    data.message = messageOf(error);
    var name = nameOf(error);
    if (name !== undefined) data.name = name;
    if (readFlag(error, '__wfRunFailure')) data.runFailure = true;
    if (readFlag(error, '__wfAbort')) data.abort = true;
    return data;
  }

  var api = objectCreate(null);
  api.watch = function (main) {
    then(main, function (value) {
      try {
        var done = message('done');
        done.ok = true;
        done.value = encodeResult(value);
        send(done);
      } catch (e) {
        var failed = message('done');
        failed.ok = false;
        failed.error = errorData(new ErrorCtor(
          'The workflow result could not be returned: ' + messageOf(e)));
        send(failed);
      }
    }, function (error) {
      var done = message('done');
      done.ok = false;
      done.error = errorData(error);
      send(done);
    });
  };
  api.receive = function (json) {
    var m = parseJson(json);
    currentContext = ROOT_CONTEXT;
    if (m.type === 'settle') {
      var entry = pending[m.id];
      if (!entry) return;
      delete pending[m.id];
      if (m.budget) budgetState = m.budget;
      // Jobs this settlement triggers continue the branch that issued it.
      currentContext = entry.context;
      if (m.ok) entry.resolve(m.value);
      else entry.reject(m.error);
    } else if (m.type === 'abort') {
      runAborted = true;
    } else if (m.type === 'flush') {
      flushUnconsumed();
      send(message('flushed'));
    }
  };
  return api;
})`;

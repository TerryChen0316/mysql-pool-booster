var Pool = require('./Pool');
var PoolConfig = require('./PoolConfig');
var PoolNamespace = require('./PoolNamespace');
var PoolSelector = require('./PoolSelector');
var ShardingPoolCluster = require('./ShardingPoolCluster');
var Util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = PoolCluster;

/**
 * PoolCluster
 * @constructor
 * @param {object} mysql The mysql object
 * @param {object} [config] The pool cluster configuration
 * @public
 */

function PoolCluster(mysql, config) {
  EventEmitter.call(this);

  config = config || {};
  this._canRetry = typeof config.canRetry === 'undefined' ? true : config.canRetry;
  this._defaultSelector = config.defaultSelector || 'RR';
  this._removeNodeErrorCount = config.removeNodeErrorCount || 5;
  this._restoreNodeTimeout = config.restoreNodeTimeout || 0;

  this._mysql = mysql;

  this._closed = false;
  this._lastId = 0;
  this._lastWriterId = 0;
  this._lastReaderId = 0;
  this._nodeKeys = [];
  this._nodes = {};
  this._findCaches = {};
  this._namespaces = {};
  this._shardings = {};
  this._shardingPoolClusterCache = {};

  if (config.nodes) {
    for (var i = 0; i < config.nodes.length; i++) {
      this.add(config.nodes[i]);
    }
  }

  if (config.shardings) {
    for (var ruleId in config.shardings) {
      this.addSharding(ruleId, config.shardings[ruleId]);
    }
  }
}

Util.inherits(PoolCluster, EventEmitter);

PoolCluster.prototype.add = function (id, config) {
  if (this._closed) {
    throw new Error('PoolCluster is closed.');
  }

  if (typeof config === 'undefined') {
    if (typeof id !== 'object') {
      throw new TypeError('Configuration must be a object.');
    }

    config = id;

    id = '';

    if (config.clusterType) {
      var clusterType = (config.clusterType || '').toLowerCase();

      if (clusterType === 'writer') {
        id = 'WRITER::' + (config.clusterId || ++this._lastWriterId);
      } else if (clusterType === 'reader') {
        id = 'READER::' + (config.clusterId || ++this._lastReaderId);
      }
    }

    if (id.length === 0) {
      id = config.clusterId || ('CLUSTER::' + (++this._lastId));
    }
  }

  if (this._nodes[id]) {
    throw new Error('Node ID "' + id + '" is already defined in PoolCluster.');
  }

  var poolConfig = new PoolConfig(this._mysql, config);

  this._nodes[id] = {
    id: id,
    errorCount: 0,
    pool: new Pool(this._mysql, {
      config: poolConfig
    }),
    _offlineUntil: 0
  };

  this._nodeKeys.push(id);

  this._clearFindCaches();
};

PoolCluster.prototype.end = function (callback) {
  var cb = callback !== undefined ? callback : _cb;

  if (typeof cb !== 'function') {
    throw TypeError('Callback arguments must be a function');
  }

  if (this._closed) {
    process.nextTick(cb);
    return;
  }

  this._closed = true;

  var calledBack = false;
  var waitingClose = 0;

  var waitingClose = this._nodeKeys.length;
  if (waitingClose === 0) {
    callback();
    return;
  }

  function onEnd(err) {
    if (!calledBack && (err || --waitingClose <= 0)) {
      calledBack = true;
      cb(err);
    }
  }

  for (var id in this._nodes) {
    var node = this._nodes[id];

    waitingClose++;
    node.pool.end(onEnd);
  }

  if (waitingClose === 0) {
    process.nextTick(onEnd);
  }
};

PoolCluster.prototype.of = function (pattern, selector) {
  pattern = pattern || '*';
  selector = typeof selector === 'undefined' ? this._defaultSelector : selector.toUpperCase();

  if (!PoolSelector[selector]) {
    selector = this._defaultSelector;
  }

  var key = pattern + selector;
  if (!this._namespaces[key]) {
    this._namespaces[key] = new PoolNamespace(this, pattern, selector);
  }

  return this._namespaces[key];
};

PoolCluster.prototype.remove = function (pattern) {
  var foundNodeIds = this._findNodeIds(pattern, true);

  for (var i = 0, len = foundNodeIds.length; i < len; i++) {
    var node = this._getNode(foundNodeIds[i]);

    if (node) {
      this._removeNode(node);
    }
  }
};

PoolCluster.prototype.getConnection = function (pattern, selector, cb) {
  var namespace;
  if (typeof pattern === 'function') {
    cb = pattern;
    namespace = this.of();
  } else {
    if (typeof selector === 'function') {
      cb = selector;
      selector = this._defaultSelector;
    }

    namespace = this.of(pattern, selector);
  }

  namespace.getConnection(cb);
};

PoolCluster.prototype.addWriter = function (config) {
  config.clusterType = 'writer';
  config.clusterId = config.clusterId;
  this.add(config);
};

PoolCluster.prototype.addReader = function (config) {
  config.clusterType = 'reader';
  config.clusterId = config.clusterId;
  this.add(config);
};

PoolCluster.prototype.getWriter = function (id) {
  return this.of('WRITER::' + (id || '*'));
};

PoolCluster.prototype.getReader = function (id) {
  return this.of('READER::' + (id || '*'));
};

PoolCluster.prototype.getWriterConnection = function (id, cb) {
  if (typeof cb === 'undefined') {
    cb = id;
    id = '*';
  }

  this.getWriter(id).getConnection(cb);
};

PoolCluster.prototype.getReaderConnection = function (id, cb) {
  if (typeof cb === 'undefined') {
    cb = id;
    id = '*';
  }

  this.getReader(id).getConnection(cb);
};

PoolCluster.prototype.addSharding = function (id, rule) {
  if (this._shardings[id]) {
    throw new Error('Sharding ID "' + id + '" is already defined in PoolCluster.');
  }

  if (typeof rule !== 'function') {
    throw TypeError('Rule argument must be a function');
  }

  this._shardings[id] = rule;
};

PoolCluster.prototype.getSharding = function (id, args) {
  if (!this._shardings[id]) {
    throw new Error('Sharding ID "' + id + '" is not defined in PoolCluster.');
  }

  args = [].concat(args);
  var shardingId = this._shardings[id].apply(null, args);

  if (!this._shardingPoolClusterCache[shardingId]) {
    this._shardingPoolClusterCache[shardingId] = new ShardingPoolCluster(this, shardingId);
  }

  return this._shardingPoolClusterCache[shardingId];
};

PoolCluster.prototype.getShardingConnection = function (id, args, callback) {
  this.getSharding(id, args).getConnection(callback);
};

PoolCluster.prototype.getShardingReaderConnection = function (id, args, callback) {
  this.getSharding(id, args).getReaderConnection(callback);
};

PoolCluster.prototype.getShardingWriterConnection = function (id, args, callback) {
  this.getSharding(id, args).getWriterConnection(callback);
};

PoolCluster.prototype._clearFindCaches = function () {
  this._findCaches = {};
};

PoolCluster.prototype._findNodeIds = function (pattern, includeOffline) {
  var currentTime = 0;
  var foundNodeIds = this._findCaches[pattern];

  if (typeof foundNodeIds === 'undefined') {
    var expression = patternRegExp(pattern);
    var nodeIds = Object.keys(this._nodes);

    foundNodeIds = nodeIds.filter(function (id) {
      return id.match(expression);
    });

    this._findCaches[pattern] = foundNodeIds;
  }

  if (this._restoreNodeTimeout === 0 || includeOffline) {
    return foundNodeIds;
  }


  return foundNodeIds.filter(function (nodeId) {
    var node = this._getNode(nodeId);

    if (!node._offlineUntil) {
      return true;
    }

    if (!currentTime) {
      currentTime = getMonotonicMilliseconds();
    }

    return node._offlineUntil <= currentTime;
  }, this);
};

PoolCluster.prototype._getNode = function (id) {
  return this._nodes[id] || null;
};

PoolCluster.prototype._increaseErrorCount = function (node) {
  var errorCount = ++node.errorCount;

  if (this._removeNodeErrorCount > errorCount) {
    return;
  }

  if (this._restoreNodeTimeout > 0) {
    node._offlineUntil = getMonotonicMilliseconds() + this._restoreNodeTimeout;
    this.emit('offline', node.id);
    return;
  }

  this._removeNode(node);
  this.emit('remove', node.id);
};

PoolCluster.prototype._decreaseErrorCount = function (node) {
  var errorCount = node.errorCount;

  if (errorCount > this._removeNodeErrorCount) {
    errorCount = this._removeNodeErrorCount;
  }

  if (errorCount < 1) {
    errorCount = 1;
  }

  node.errorCount = errorCount - 1;

  if (node._offlineUntil) {
    node._offlineUntil = 0;
    this.emit('online', node.id);
  }
};

PoolCluster.prototype._getNodeConnection = function (node, cb) {
  var self = this;

  node.pool.getConnection(function (err, connection) {
    if (err) {
      self._increaseErrorCount(node);
      cb(err);
      return;
    }

    self._decreaseErrorCount(node);

    connection._clusterId = node.id;

    cb(null, connection);
  });
};

PoolCluster.prototype._removeNode = function (node) {
  delete this._nodes[node.id];

  var keyIndex = this._nodeKeys.indexOf(node.id);
  if (keyIndex !== -1) {
    this._nodeKeys.splice(keyIndex, 1);
  }

  this._clearFindCaches();
  node.pool.end(_noop);
};

PoolCluster.prototype._hasOfflineNodes = function () {
  for (var i = 0, len = this._nodeKeys.length; i < len; i++) {
    var id = this._nodeKeys[i];
    console.log(`PoolCluster._hasOfflineNodes._nodeKeys=${id}, _offlineUntil=${this._nodes[id]._offlineUntil}`)
    if (this._nodes[id]._offlineUntil > 0) {
      return true;
    }
  }

  return false;
};

function getMonotonicMilliseconds() {
  var ms;

  if (typeof process.hrtime === 'function') {
    ms = process.hrtime();
    ms = ms[0] * 1e3 + ms[1] * 1e-6;
  } else {
    ms = process.uptime() * 1000;
  }

  return Math.floor(ms);
}

function isRegExp(val) {
  return typeof val === 'object' &&
    Object.prototype.toString.call(val) === '[object RegExp]';
}

function patternRegExp(pattern) {
  if (isRegExp(pattern)) {
    return pattern;
  }

  var source = pattern
    .replace(/([.+?^=!:${}()|\[\]\/\\])/g, '\\$1')
    .replace(/\*/g, '.*');

  return new RegExp('^' + source + '$');
}

function _cb(err) {
  if (err) {
    throw err;
  }
}

function _noop() {}
const url          = require('url');
const _            = require('lodash');
const EventEmitter = require('events').EventEmitter;
const util         = require('util');
const reconnect    = require('reconnect-net');
const failover     = require('tcp-client-failover');
const Transform    = require('stream').Transform;
const Protocol     = require('limitd-protocol');

const disyuntor    = require('disyuntor');

const lps = require('length-prefixed-stream');
const lpm = require('length-prefixed-message');

const defaults = {
  port: 9231,
  host: 'localhost'
};

function QueuedRequest(callback) {
  this.start = new Date();
  this.callback = callback;
}

function LimitdClient (options, done) {
  if (options && options.shard) {
    const ShardClient  = require('./shard_client');
    return new ShardClient(options, done);
  }

  EventEmitter.call(this);

  if (typeof options === 'string') {
    options = {
      hosts: [ options ]
    };
  } else if(Array.isArray(options)) {
    options = {
      hosts: options
    };
  } else if(typeof options === 'object') {
    if ('host' in options) {
      const host = options.host;
      options = _.extend(_.omit(options, 'host'), { hosts: [host] });
    } else {
      //clone the graph but keep stream.
      options = _.extend(_.cloneDeep(options), { stream: options.stream});
    }
  } else {
    options = { hosts: [] };
  }

  this._options = options;

  if (!options.hosts || options.hosts.length === 0) {
    options.hosts = [ defaults ];
  }

  options.hosts = _.map(options.hosts, (host) => {
    if (typeof host === 'string') {
      if (host.match(/\.socket$/)) {
        host = { port: host };
      } else {
        host = _.pick(url.parse(host), ['port', 'hostname']);
        host.port = host.port ? parseInt(host.port, 10) : defaults.port;
      }
    }
    return host;
  });

  this.pending_requests = Object.create(null);

  this.connect(done);

  if (!options.breaker) {
    options.breaker = {};
  }

  options.breaker.timeout = options.breaker.timeout || options.timeout || '1s';

  // this._request = this._directRequest;
  this._request = disyuntor((request, callback) => {
    this._directRequest(request, callback);
  }, _.extend({
    name: 'limitd.request',
    onTrip: (err, failures, cooldown) => {
      this.emit('trip', err, failures, cooldown);
    },
    trigger: err => err && err.message !== 'Invalid bucket type'
  }, options.breaker || { }));

  this.resetCircuitBreaker = () => this._request.reset();

  this.currentId = 0;

  this.protocol_version = options.protocol_version || 1;
}

util.inherits(LimitdClient, EventEmitter);

LimitdClient.prototype.nextId = function () {
  //start from 1 and conver to string because the protocol uses strings.
  if (this.currentId < Number.MAX_SAFE_INTEGER) {
    this.currentId++;
  } else {
    this.currentId = 1;
  }

  if (this.protocol_version < 2) {
    //old version support only string ids.
    return this.currentId + '';
  }

  return this.currentId;
};

LimitdClient.prototype.connect = function (done) {
  var options = this._options;

  if (options.stream) {
    return this._onNewStream(options.stream);
  }

  if (options.hosts.length > 1) {
    this._connectUsingFailover(done);
  } else {
    this.host = options.hosts[0];
    this._connectUsingReconnect(done);
  }
};

LimitdClient.prototype._connectUsingReconnect = function (done) {
  const hostConfig = this._options.hosts[0];
  const host = hostConfig.address || hostConfig.hostname || hostConfig.host;
  const port = hostConfig.port;

  done = done || _.noop;

  this.socket = reconnect({
                  initialDelay: 200,
                  maxDelay: 1000
                }, stream => {
                  this._onNewStream(stream);
                }).once('connect', (connection) => {
                  connection.setKeepAlive(true, 50);
                  connection.setNoDelay();
                  setImmediate(() => {
                    this.emit('connect');
                    done();
                  });
                }).on('close', (has_error) => {
                  this.emit('close', has_error);
                }).on('error', (err) => {
                  this.emit('error', err);
                }).on('reconnect', (n, delay) => {
                  this.emit('reconnect', n, delay);
                }).connect(port, host);
};

LimitdClient.prototype._connectUsingFailover = function (done) {
  var self = this;

  done = done || _.noop;

  self.failover = failover.connect(self._options.hosts)
  .on('connected', (stream) => {
    self._onNewStream(stream);
    setImmediate(function () {
      self.emit('connect');
      done();
    });
  })
  .on('disconnected', function () {
    self.emit('close');
  })
  .on('error', function (err) {
    self.emit('error', err);
  });
};

LimitdClient.prototype._onNewStream = function (stream) {
  stream
  .pipe(lps.decode())
  .pipe(Transform({
    objectMode: true,
    transform(chunk, enc, callback) {
      callback(null, Protocol.Response.decode(chunk));
    }
  }))
  .on('data', (response) => {
    const queuedRequest = this.pending_requests[response.request_id];
    this._responseHandler(response, queuedRequest);
  })
  .on('error', (err) => {
    this.emit('error', err);
  });

  this.stream = stream;

  this.emit('ready');
};

LimitdClient.prototype.disconnect = function () {
  if (this.socket) {
    this.socket.disconnect();
  }

  if (this.failover) {
    this.failover.disconnect();
  }
};

LimitdClient.prototype._responseHandler = function(response, queuedRequest) {
  delete this.pending_requests[response.request_id];

  if (!queuedRequest) { return; }

  if (response.error &&
      response.error.type === 'UNKNOWN_BUCKET_TYPE') {
    return queuedRequest.callback(new Error('Invalid bucket type'));
  }

  const resp = response[response.body];


  if (resp) {
    resp.took = Date.now() - queuedRequest.start;

    if (typeof resp.protocol_version !== 'undefined') {
      this.protocol_version = resp.protocol_version;
    }
  }

  this.emit('response', resp);

  queuedRequest.callback(null, resp);
};

LimitdClient.prototype._fireAndForgetRequest = function (request) {
  if (!this.stream || !this.stream.writable) {
    const err = new Error(`Unable to send ${request.method} to limitd. The socket is closed.`);
    return this.emit('error', err);
  }

  lpm.write(this.stream, Protocol.Request.encode(request));
};

LimitdClient.prototype._directRequest = function (request, callback) {
  if (!this.stream || !this.stream.writable) {
    const err = new Error(`Unable to send ${request.method} to limitd. The socket is closed.`);
    return setImmediate(callback, err);
  }

  lpm.write(this.stream, Protocol.Request.encode(request));

  this.pending_requests[request.id] = new QueuedRequest(callback);
};

LimitdClient.prototype._takeOrWait = function (method, type, key, count, done) {
  if (typeof count === 'function') {
    done = count;
    count = 1;
  } else if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = _.noop;
    count = 1;
  } else if (typeof done !== 'function') {
    done = _.noop;
  }

  const takeAll = count === 'all';

  if (typeof key !== 'string') {
    key = '';
  }

  const request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': method,
  };

  if (takeAll) {
    request.all = true;
  } else {
    request.count = count;
  }

  return this._request(request, done);
};

LimitdClient.prototype.take = function (type, key, count, done) {
  return this._takeOrWait('TAKE', type, key, count, done);
};

LimitdClient.prototype.wait = function (type, key, count, done) {
  return this._takeOrWait('WAIT', type, key, count, done);
};

LimitdClient.prototype.reset =
LimitdClient.prototype.put = function (type, key, count, done) {
  if (typeof count === 'function') {
    done = count;
    count = 'all';
  } else if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = undefined;
    count = 'all';
  }


  const reset_all = count === 'all';

  const fireAndForget = typeof done !== 'function';

  if (typeof key !== 'string') {
    key = '';
  }

  const request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': 'PUT',
    'skipResponse': fireAndForget
  };

  if (reset_all) {
    request.all = true;
  } else {
    request.count = count;
  }

  if (fireAndForget) {
    return this._fireAndForgetRequest(request);
  }

  return this._request(request, done);
};

LimitdClient.prototype.status = function (type, key, done) {
  if (typeof key !== 'string') {
    key = '';
  }

  const request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': 'STATUS',
  };

  return this._request(request, done);
};

LimitdClient.prototype.ping = function (done) {
  const request = {
    'id':     this.nextId(),
    'type':   '',
    'key':    '',
    'method': 'PING',
  };

  return this._request(request, done);
};

module.exports = LimitdClient;

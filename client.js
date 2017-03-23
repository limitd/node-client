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
  } else if(typeof options === 'object' && 'host' in options) {
    const host = options.host;
    options = _.extend(_.omit(options, 'host'), { hosts: [host] });
  } else {
    options = options && _.cloneDeep(options) || { hosts: [] };
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
        host.port = typeof host.port !== 'undefined' ? parseInt(host.port, 10) : undefined;
      }
    }
    return host;
  });

  this.pending_requests = new Map();

  this.connect(done);

  if (!options.breaker) {
    options.breaker = {};
  }

  options.breaker.timeout = options.breaker.timeout || options.timeout || '1s';

  this._request = disyuntor(this._request.bind(this), _.extend({
    name: 'limitd.request',
    monitor: details => {
      this.emit('breaker_error', details.err);
    }
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
  var self = this;

  stream
  .pipe(lps.decode())
  .pipe(Transform({
    objectMode: true,
    transform(chunk, enc, callback) {
      callback(null, Protocol.Response.decode(chunk));
    }
  }))
  .on('data', function (response) {
    var response_handler = self.pending_requests.get(response.request_id);
    if (response_handler) {
      response_handler(response);
    }
  })
  .on('error', function (err) {
    self.emit('error', err);
  });

  self.stream = stream;

  self.emit('ready');
};

LimitdClient.prototype.disconnect = function () {
  if (this.socket) {
    this.socket.disconnect();
  }

  if (this.failover) {
    this.failover.disconnect();
  }
};

LimitdClient.prototype._responseHandler = function(requestID, callback) {
  const start = Date.now();

  return (response) => {
    this.pending_requests.delete(requestID);

    if (response.error &&
        response.error.type === 'UNKNOWN_BUCKET_TYPE') {
      return callback(new Error('Invalid bucket type'));
    }

    const resp = response[response.body];

    if (typeof resp.protocol_version !== 'undefined') {
      this.protocol_version = resp.protocol_version;
    }

    if (resp) {
      resp.took = Date.now() - start;
    }

    this.emit('response', resp);

    callback(null, resp);
  };
};

LimitdClient.prototype._fireAndForgetRequest = function (request) {
  if (!this.stream || !this.stream.writable) {
    const err = new Error(`Unable to send ${request.method} to limitd. The socket is closed.`);
    return this.emit('error', err);
  }

  lpm.write(this.stream, Protocol.Request.encode(request));
};

LimitdClient.prototype._request = function (request, type, callback) {
  if (!this.stream || !this.stream.writable) {
    const err = new Error(`Unable to send ${request.method} to limitd. The socket is closed.`);
    return setImmediate(callback, err);
  }

  lpm.write(this.stream, Protocol.Request.encode(request));

  this.pending_requests.set(request.id, this._responseHandler(request.id, callback));
};

LimitdClient.prototype._takeOrWait = function (method, type, key, count, done) {
  if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = _.noop;
    count = 1;
  }

  if (typeof count === 'function') {
    done = count;
    count = 1;
  }

  if (typeof done !== 'function') {
    done = _.noop;
  }

  const takeAll = count === 'all';

  const request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': method,
    'all':    takeAll || null,
    'count':  !takeAll ? count : undefined
  };

  return this._request(request, type, done);
};

LimitdClient.prototype.take = function (type, key, count, done) {
  return this._takeOrWait('TAKE', type, key, count, done);
};

LimitdClient.prototype.wait = function (type, key, count, done) {
  return this._takeOrWait('WAIT', type, key, count, done);
};

LimitdClient.prototype.reset =
LimitdClient.prototype.put = function (type, key, count, done) {
  if (typeof count === 'undefined' && typeof done === 'undefined') {
    done = undefined;
    count = 'all';
  }

  if (typeof count === 'function') {
    done = count;
    count = 'all';
  }

  const reset_all = count === 'all';

  const fireAndForget = typeof done !== 'function';

  const request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': 'PUT',
    'all':    reset_all ? true : null,
    'count':  !reset_all ? count : undefined,
    'skipResponse': fireAndForget
  };

  if (fireAndForget) {
    return this._fireAndForgetRequest(request);
  }

  return this._request(request, type, done);
};

LimitdClient.prototype.status = function (type, key, done) {
  var request = {
    'id':     this.nextId(),
    'type':   type,
    'key':    key,
    'method': 'STATUS',
  };

  return this._request(request, type, done);
};

LimitdClient.prototype.ping = function (done) {
  var request = {
    'id':     this.nextId(),
    'type':   '',
    'key':    '',
    'method': 'PING',
  };

  return this._request(request, '', done);
};

module.exports = LimitdClient;

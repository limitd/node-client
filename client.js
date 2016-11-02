const url              = require('url');
const _                = require('lodash');
const EventEmitter     = require('events').EventEmitter;
const util             = require('util');
const randomstring     = require('randomstring');
const reconnect        = require('reconnect-net');
const failover         = require('tcp-client-failover');
const Transform        = require('stream').Transform;

const RequestMessage   = require('./lib/protocol').Request;
const ResponseMessage  = require('./lib/protocol').Response;
const ErrorResponse    = require('./lib/protocol').ErrorResponse;
const disyuntor        = require('disyuntor');
const lps              = require('length-prefixed-stream');

var defaults = {
  port: 9231,
  host: 'localhost'
};

function LimitdClient (options, done) {

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
    options = {
      hosts: [ options ]
    };
  } else {
    options = options && _.cloneDeep(options) || { hosts: [] };
  }

  this._options = options;

  if (options.hosts.length === 0) {
    options.hosts.push(defaults);
  }

  options.hosts = _.map(options.hosts, (host) => {
    if (typeof host === 'string') {
      host = _.pick(url.parse(host), ['port', 'hostname']);
      host.port = typeof host.port !== 'undefined' ? parseInt(host.port, 10) : undefined;
    }
    return host;
  });

  this.pending_requests = {};
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
}

util.inherits(LimitdClient, EventEmitter);

LimitdClient.prototype.connect = function (done) {
  var options = this._options;

  if (options.hosts.length > 1) {
    this._connectUsingFailover(done);
  } else {
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
      try {
        const decoded = ResponseMessage.decode(chunk);
        this.push(decoded);
      } catch(err) {
        return callback(err);
      }
      callback();
    }
  }))
  .on('data', function (response) {
    var response_handler = self.pending_requests[response.request_id];
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

LimitdClient.prototype._request = function (request, type, callback) {
  const client = this;

  if (!this.stream || !this.stream.writable) {
    const err = new Error('The socket is closed.');
    if (callback) {
      return setImmediate(callback, err);
    } else {
      throw err;
    }
  }

  this.stream.write(request.encodeDelimited().toBuffer());

  const start = Date.now();

  client.pending_requests[request.id] = (response) => {
    delete client.pending_requests[request.id];

    if (response['.limitd.ErrorResponse.response'] &&
        response['.limitd.ErrorResponse.response'].type === ErrorResponse.Type.UNKNOWN_BUCKET_TYPE) {
      return callback(new Error(type + ' is not a valid bucket type'));
    }

    this.emit('response', {
      took: Date.now() - start,
      request
    });

    callback(null, response['.limitd.TakeResponse.response'] ||
                   response['.limitd.PutResponse.response']  ||
                   response['.limitd.StatusResponse.response'] );
  };
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

  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method[method],
  });

  if (count === 'all') {
    request.set('all', true);
  } else {
    request.set('count', count);
  }

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
    done = _.noop;
    count = 'all';
  }

  if (typeof count === 'function') {
    done = count;
    count = 'all';
  }

  if (typeof done === 'undefined') {
    done = _.noop;
  }

  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method.PUT,
  });

  if (count === 'all') {
    request.set('all', true);
  } else {
    request.set('count', count);
  }

  return this._request(request, type, done);
};

LimitdClient.prototype.status = function (type, key, done) {
  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   type,
    'key':    key,
    'method': RequestMessage.Method.STATUS,
  });

  return this._request(request, type, done);
};

LimitdClient.prototype.ping = function (done) {
  var request = new RequestMessage({
    'id':     randomstring.generate(7),
    'type':   '',
    'key':    '',
    'method': RequestMessage.Method.PING,
  });

  return this._request(request, '', done);
};

module.exports = LimitdClient;

const LimitdClient = require('./client');
const EventEmitter = require('events').EventEmitter;
const Hashring = require('hashring');

const _      = require('lodash');
const async  = require('async');
const dns    = require('dns');
const util   = require('util');
const url    = require('url');

const ms = require('ms');

const defaults = {
  port: 9231
};

function ShardClient(options, deps) {
  deps = deps || {};

  if (typeof options !== 'object' || typeof options.shard !== 'object') {
    throw new Error('shard is required');
  }

  EventEmitter.call(this);

  this._LimitdClient = deps.LimitdClient || LimitdClient;
  this._dns = deps.dns || dns;

  this._options = _.extend({}, defaults, options);
  this._clientParams = _.omit(this._options, ['shard', 'port']);

  if (Array.isArray(this._options.shard.hosts)) {
    this.clients = this._options.shard.hosts.reduce((result, host) => {
      if (url.parse(host).protocol === null) {
        result[`${host}:${this._options.port}`] = this.createClient(`limitd://${host}:${this._options.port}`);
      } else {
        result[host.replace(/^(.*)\/\//, '')] = this.createClient(host);
      }
      return result;
    }, {});
    this.ring = new Hashring(Object.keys(this.clients));
  } else if (this._options.shard.autodiscover) {
    this.autodiscover = _.extend({ refreshInterval: ms('5m') }, this._options.shard.autodiscover);
    this.clients = {};
    this.ring = new Hashring([]);
    this.discover();
  } else {
    throw new Error('unsupported shard configuration');
  }
}

util.inherits(ShardClient, EventEmitter);


ShardClient.prototype.createClient = function(host) {
  const client = new this._LimitdClient(_.extend(this._clientParams, { host }));
  if (client instanceof EventEmitter) {
    //map the events from LimitdClient.
    //Last parameter is always the underlying client.
    client.on('error',         (err) => this.emit('error', err, client))
          .on('trip',          (err, failures, cooldown) => this.emit('trip', err, failures, cooldown, client))
          .on('connect',       ()    => this.emit('connect', client))
          .on('disconnect',    (err)    => this.emit('disconnect', err, client))
          .on('reconnect',     (n, delay)    => this.emit('reconnect', n, delay, client))
          .on('close',         ()    => this.emit('close', client))
          .on('ready',         ()    => this.emit('ready', client))
          .on('response',      (r)   => this.emit('response', r, client));
  }
  return client;
};

ShardClient.prototype.discover = function() {
  this._dns.resolve(this.autodiscover.address, this.autodiscover.type || 'A', (err, ips) => {
    setTimeout(() => this.discover(), this.autodiscover.refreshInterval);
    if (err) {
      return this.emit('error', err);
    }

    ips.filter(ip => !this.ring.servers.some(s => s.host === ip && s.port === this._options.port))
      .forEach(newIp => {
        const ipPort = `${newIp}:${this._options.port}`;
        this.ring.add(ipPort);
        this.clients[ipPort] = this.createClient(`limitd://${ipPort}`);
        this.emit('new client', this.clients[ipPort]);
      });

    this.ring.servers
        .filter(server => !ips.some(ip => server.host === ip))
        .forEach(oldServer => {
          const ipPort = `${oldServer.host}:${oldServer.port}`;
          if (this.clients[ipPort]) {
            this.ring.remove(ipPort);
            const client = this.clients[ipPort];
            client.disconnect();
            delete this.clients[ipPort];
            this.emit('removed client', client);
          }
        });
  });
};

ShardClient.prototype.getDestinationClient = function(type, key) {
  if (!this.clients || this.clients.length === 0) {
    return;
  }
  return this.clients[this.ring.get(`${type}:${key}`)];
};

['reset', 'put', 'take', 'wait'].forEach(method => {
  ShardClient.prototype[method] = function(type, key) {
    const client = this.getDestinationClient(type, key);
    if (!client) {
      const lastArg = arguments[arguments.length - 1];
      if (typeof lastArg === 'function') {
        return setImmediate(lastArg, new Error('no shard available'));
      }
      return;
    }
    return client[method].apply(client, arguments);
  };
});

ShardClient.prototype.status = function(type, prefix, callback) {
  async.map(this.clients, (client, callback) => {
    client.status(type, prefix, (err, response) => {
      if (err) {
        return callback(null, { error: err });
      }

      response.items = response.items.filter(i => this.getDestinationClient(type, i.instance) === client);
      callback(null, response);
    });
  }, (err, responses) => {
    if (err) { return callback(err); }

    callback(null, {
      items:  _.flatten(responses.map(r => r.items).filter(Array.isArray)),
      errors: responses.map(r => r.error).filter(e => e)
    });
  });
};

ShardClient.prototype.disconnect = function() {
  this.clients.forEach(client => client.disconnect());
};

ShardClient.prototype.ping = function(callback) {
  async.each(
      this.clients,
      (client, callback) => client.ping(callback),
      callback);
};

module.exports = ShardClient;

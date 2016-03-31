var Random = require('random-js');
var engine = Random.engines.mt19937().autoSeed();
var distribution = Random.integer(0, 61);
var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

module.exports = function (len) {
  len = len || 16;

  var id = '';

  while(len--){
    id += chars[distribution(engine)];
  }

  return id;
};
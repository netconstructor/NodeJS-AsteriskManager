/*
 * NodeJS Asterisk Manager API
 * (Based on https://github.com/mscdex/node-asterisk.git)
 * But radically altered thereafter so as to constitute a new work.
 *
 * © See LICENSE file
 *
 */
/* jshint node:true, newcap:false */
'use strict';
var debug = false;

var EventEmitter = require('events').EventEmitter
  , Net = require('net')
  , Utils = require('./utils');

var Manager = function Manager(port, host, username, password, events) {
  
  var obj = {}
    , context = {}
    , properties = ['on', 'once', 'addListener', 'removeListener', 'removeAllListeners',
                    'listeners', 'setMaxListeners', 'emit'];

  context.emitter = new EventEmitter();
  context.held = [];

  properties.map(function(property){
    Object.defineProperty(obj, property, {
      value: context.emitter[property].bind(context.emitter)
    });
  })

  obj.connect = ManagerConnect.bind(obj, context);
  obj.keepConnected = ManagerKeepConnected.bind(obj, context);
  obj.login = ManagerLogin.bind(obj, context);
  obj.action = ManagerAction.bind(obj, context);
  obj.disconnect = ManagerDisconnect.bind(obj, context);
  obj.isConnected = ManagerIsConnected.bind(obj, context);
  obj.connected = obj.isConnected;

  obj.on('rawevent', ManagerEvent.bind(obj, context));

  if (port) obj.connect(port, host, username ? obj.login.bind(obj, username, password, events) : undefined);

  return obj;
};

function ManagerConnect(context, port, host, callback) {
  callback = Utils.defaultCallback(callback);

  context.connection = (context.connection && (context.connection.readyState != 'closed')) ? context.connection : undefined;

  if (context.connection)
    return callback.call(this, null);

  context.authenticated = false;
  context.connection = Net.createConnection(port, host);
  context.connection.once('connect', callback.bind(this, null));
  context.connection.on('connect', this.emit.bind(this, 'connect'));
  context.connection.on('close', this.emit.bind(this, 'close'));
  context.connection.on('end', this.emit.bind(this, 'end'));
  context.connection.on('data', ManagerReader.bind(this, context));
  context.connection.on('error', ManagerConnectionError.bind(this, context));
  context.connection.setEncoding('utf-8');
}

function ManagerConnectionError(context, error) {
  this.emit('error', error);
  if (debug) {
    error = String(error.stack).split(/\r?\n/);
    var msg = error.shift();
    error = error.map(function(line) {
      return ' ↳ ' + line.replace(/^\s*at\s+/, '');
    });
    error.unshift(msg);
    error.forEach(function(line) {
      process.stderr.write(line + '\n');
    });
  }
}

function ManagerReader(context, data) {

  context.lines = context.lines || [];
  context.leftOver = context.leftOver || '';
  context.leftOver += String(data);
  context.lines = context.lines.concat(context.leftOver.split(/\r?\n/));
  context.leftOver = context.lines.pop();

  var lines = []
    , follow = 0
    , item = {};
  while (context.lines.length) {
    var line = context.lines.shift();
    if (!lines.length && (line.substr(0, 21) === 'Asterisk Call Manager')) {
      // Ignore Greeting
    } else if (!lines.length && (line.substr(0, 9).toLowerCase() === 'response:') && (line.toLowerCase().indexOf('follow') > -1)) {
      follow = 1;
      lines.push(line);
    } else if (follow && (line === '--END COMMAND--')) {
      follow = 2;
      lines.push(line);
    } else if ((follow > 1) && !line.length) {
      follow = 0;
      lines.pop();
      item = {
        'response': 'follows',
        'content': lines.join('\n')
      };

      var matches = item.content.match(/actionid: ([^\r\n]+)/i);
      item.actionid = matches ? matches[1] : item.actionid;

      lines = [];
      this.emit('rawevent', item);
    } else if (!follow && !line.length) {
      // Have a Complete Item
      lines = lines.filter(Utils.stringHasLength);
      item = {};
      while (lines.length) {
        line = lines.shift();
        line = line.split(':');
        var key = Utils.removeSpaces(line.shift()).toLowerCase();
        line = Utils.removeSpaces(line.join(':'));
        item[key] = line;
      }
      context.follow = false;
      lines = [];
      this.emit('rawevent', item);
    } else {
      lines.push(line);
    }
  }
  context.lines = lines;


}

function ManagerEvent(context, event) {
  var emits = [];
  if (event.response && event.actionid) {
    // This is the response to an Action
    emits.push(this.emit.bind(this, event.actionid, (event.response.toLowerCase() == 'error') ? event : undefined, event));
    emits.push(this.emit.bind(this, 'response', event));
  } else if (event.response && event.content) {
    // This is a follows response
    emits.push(this.emit.bind(this, context.lastid, undefined, event));
    emits.push(this.emit.bind(this, 'response', event));
  } else if (event.event) {
    // This is a Real-Event
    emits.push(this.emit.bind(this, 'managerevent', event));
    emits.push(this.emit.bind(this, event.event.toLowerCase(), event));
    if (('userevent' === event.event.toLowerCase()) && event.userevent)
      emits.push(this.emit.bind(this, 'userevent-' + event.userevent.toLowerCase(), event));

  } else {
    // Ooops I dont know what this is
    emits.push(this.emit.bind(this, 'asterisk', event));
  }
  emits.forEach(process.nextTick.bind(process));
}

function ManagerLogin(context, username, password, events, callback) {
  callback = Utils.defaultCallback(callback);

  this.action({
    'action': 'login',
    'username': username || '',
    'secret': password || '',
    'event': events ? 'on' : 'off'
  }, (function(err) {
    if (err) 
      return callback(err);

    process.nextTick(callback.bind(this));
    context.authenticated = true;
    
    var held = context.held;
    context.held = [];
    held.forEach((function(held) {
      this.action(held.action, held.callback);
    }).bind(this));

  }).bind(this));

  return;
}

function ManagerKeepConnected(context, port, host, username, password, events, timeout) {
  if (context.reconnect) return;

  context.reconnect = global.setTimeout.bind(global, this.connect.bind(this, port, host, this.login.bind(this, username || '', password || '', events || false)), isNaN(timeout) ? 5000 : timeout);
  this.on('close', context.reconnect);

  if (!context.connection || (context.connection.readyState != 'open'))
    context.reconnect();
}

function MakeManagerAction(req, id) {
  var msg = [];
  msg.push('ActionID: ' + id);
  msg = msg.concat(Object.keys(req).map(function(key) {

    var nkey = Utils.removeSpaces(key).toLowerCase();
    if (!nkey.length || ('actionid' == nkey))
      return;

    var nval = req[key];
    nkey = nkey.substr(0, 1).toUpperCase() + nkey.substr(1);
    switch (typeof nval) {
      case 'undefined':
        return;
      case 'object':
        if (!nval) return;
        if (nval instanceof Array) {
          nval = nval.map(function(e) {
            return String(e);
          }).join(',');
        } else if (nval instanceof RegExp === false) {
          nval = Object.keys(nval).map(function(name) {
            return [name, nval[name]].join('=');
          }).join(',');
        }
        break;
      default:
        nval = String(nval);
        break;
    }
    return [nkey, nval].join(': ');
  }).filter(function(line) {
    return line ? true : false;
  }));
  msg.sort();
  return msg.join('\r\n') + '\r\n\r\n';
}

function ManagerAction(context, action, callback) {
  action = action || {};
  callback = Utils.defaultCallback(callback);

  var id = action.actionid || String((new Date()).getTime());

  while (this.listeners(id).length)
    id += String(Math.floor(Math.random() * 9));

  if (action.actionid)
    delete action.actionid;

  if (!context.authenticated && (action.action !== 'login')) {
    context.held = context.held || [];
    action.actionid = id;
    context.held.push({
      action: action,
      callback: callback
    });
    return id;
  }

  this.once(id, callback);
  context.lastid = id;
  
  if (!context.connection) {
    console.log('ERROR!: there is no connection yet!')
  } else {
    context.connection.write(MakeManagerAction(action, id), 'utf-8');  
    return id;
  }
  
}

function ManagerDisconnect(context, callback) {
  
  if (context.reconnect)
    this.removeListener('on', context.reconnect);

  if (context.connection && context.connection.readyState === 'open')
    context.connection.end();

  delete context.connection;

  if ('function' === typeof callback) 
    setImmediate(callback);
}

function ManagerIsConnected(context) {
  return (context.connection && context.connection.readyState === 'open');
}

// Expose `Manager`.
module.exports = Manager;

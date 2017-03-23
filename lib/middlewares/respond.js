var fs = require('fs');
var path = require('path');
var mime =require('mime');
var responders = require('./responders');
var utils = require('../utils');
var log = require('../log');
var url = require('url');

var httpRxg = /^http/;
var imgRxg = /(\.(img|png|gif|jpg|jpeg))$/i

var cwd = require('process').cwd();

/**
 * Respond to the request with the specified responder if the url
 * matches the defined url pattern from the responder list file.
 * The following three kinds of responders are supported.
 * 1. Single file (from local or internet)
 * 2. Combo file
 * 3. Directory Mapping
 * 4. custom function(for other combo cases)(TODO)
 *
 * @param {String} responderListFilePath 
 */
function respond(responderListFilePath){
  var responderConfig = _loadResponderConfig(responderListFilePath);
  var responderList = responderConfig.responders;

  //watch the rule file
  _watchRuleFile(responderListFilePath, function(){
    responderConfig = _loadResponderConfig(responderListFilePath);
    responderList = responderConfig.responders;
  });

  return function respond(req, res, next){
    var url = utils.processUrl(req);
    var originalPattern;
    var responder;
    var matched = false;
    var respondObj;
    var stat;

    /**
     * For directory mapping
     */
    var extDirectoryOfRequestUrl;
    var localDirectory;


    var imgFileBasePath;

    log.debug('respond: ' + url);

    for(var i = 0, len = responderList.length; i < len; i++){
      respondObj = responderList[i];
      originalPattern = respondObj.pattern;
      responder = respondObj.responder;

      // adapter pattern to RegExp object
      if(typeof originalPattern !== 'string' && !(originalPattern instanceof RegExp)){
        log.error()
        throw new Error('pattern must be a RegExp Object or a string for RegExp');
      }

      console.log('pattern: ' + originalPattern + ', url: ' + url 
        + ', matched: ' + _matchPattern(originalPattern, url));

      if(_matchPattern(originalPattern, url)){
        log.info('matched url: ' + url);
        log.debug('before fix responder: ' + JSON.stringify(responder));

        matched = true;
        responder = _absFilePath(responderConfig, respondObj, url);

        log.debug('after fix responder: ' + JSON.stringify(responder));

        if (typeof responder === 'string') {
          if (httpRxg.test(responder)) {
            responders.respondFromWebFile(responder, req, res, next);

          } else {
            fs.stat(responder, function(err, stat){
              if (err) {
                log.error(err.message + 'for (' + url + ')' +
                    ' then directly forward it!');
                next();
              } else {
                if(stat.isFile()){ // local file
                  responders.respondFromLocalFile(responder, req, res, next);
                } else if (stat.isDirectory()){ // directory mapping
                  var urlWithoutQS = utils.processUrlWithQSAbandoned(url);
                  var directoryPattern = url.match(pattern)[0];
                  extDirectoryOfRequestUrl = urlWithoutQS.substr(
                      urlWithoutQS.indexOf(directoryPattern) + directoryPattern.length);
                  localDirectory = path.join(responder, 
                      path.dirname(extDirectoryOfRequestUrl));

                  utils.findFile(localDirectory, 
                      path.basename(extDirectoryOfRequestUrl),
                      function(err, file){
                        log.debug('Find local file: ' + file + ' for (' + url + ')');
                        if (err) {
                          log.error(err.message + ' for (' + url + ')' + 
                              ' then directly forward it!');
                          next();
                        } else {
                          responders.respondFromLocalFile(file, req, res, next);
                        }
                  });
                }
              }
            });
          }

        } else if (Array.isArray(responder)) {
          responders.respondFromCombo({
            dir: null,
            src: responder
          }, req, res, next);

        } else if (typeof responder === 'object' && responder !== null) {
          responders.respondFromCombo({
            dir: responder.dir,
            src: responder.src
          }, req, res, next);

        } else {
          log.error('Responder for ' + url + 'is invalid!');
          next();
        }
        break;
      }
    }

    if(!matched){
      // log.info('forward: ' + url);
      next();
    }
  }
};

/**
 * For some responder with regular expression variable like $1, $2, 
 * it should be replaced with the actual value
 * 
 * @param {Regular Express Object} pattern matched array
 * @param {String} responder, replaced string
 */
function fixResponder(url, pattern, responder){
  var $v = /\$\d+/g;
  var m;
  var newRx;
  if(!$v.test(responder)){
    return responder;
  }

  m = url.match(pattern);

  if(!Array.isArray(m)){
    return responder;
  }

  for(var i = 0, l = m.length; i < l; i++){
    newRx = new RegExp('\\$' + i, 'g');
    responder = responder.replace(newRx, m[i]);
  }

  return responder;
}


/**
 * Watch the rule file to support applying changed rules without restart the proxy
 *
 * @param {String} file the path of the file
 * @param {Function} callback
 */
function _watchRuleFile(file, callback){
  fs.watchFile(file, function(curr, prev){
    log.warn('The rule file has been modified!');
    callback();
  });
};

/**
 * Load the list file and return the list object
 *
 * @param {String} responderListFilePath
 * @return {Array} responder list
 * 
 * @api private
 */
function _loadResponderConfig(responderListFilePath){
  var filePath = responderListFilePath;

  if(typeof filePath !== 'string'){
    return null;
  }

  if(!fs.existsSync(responderListFilePath)){
    throw new Error('File doesn\'t exist!');
  }

  if(!utils.isAbsolutePath(responderListFilePath)){
    filePath = path.join(process.cwd(), filePath);
  }

  return _loadFile(filePath);
}

/**
 * Load file without cache
 *
 * @return {Array} load list from a file
 */
function _loadFile(filename){
  var module = require(filename);
  delete require.cache[require.resolve(filename)];
  return module;
}

function _absFilePath(config, respondObj, urlString) {
  var responder = respondObj.responder;

  var basename = null;
  if (typeof responder === 'string') {
    basename = responder;
  } else if (typeof responder.src === 'string') {
    basename = path.basename(responder.src);
  } else if (urlString) {
    basename = path.basename(url.parse(urlString).pathname);
  } else {
    throw new Error('basename is null');
  }
  var fpath = '';

  if (responder.src && /http/i.test(responder.src)) {
    return responder.src;

  } else if (typeof responder === 'string' && path.isAbsolute(responder)) {
    fpath = responder;

  } else if (responder.src && path.isAbsolute(responder.src)) {
    fpath = responder.src;

  } else if (responder.dir && path.isAbsolute(responder.dir)) {
    fpath = path.join(responder.dir, basename);

  } else if (config.dir && path.isAbsolute(config.dir)) {
    fpath = path.join(config.dir, basename);

  } else {
    if (config.dir) {
      fpath = path.join(config.dir);
    } 
    if (responder.dir) {
      fpath = path.join(fpath, responder.dir);
    } 
    if (basename) {
      fpath = path.join(fpath, basename);
      console.log(fpath);
    }
  }
  return path.join(cwd, fpath);
}

function _matchPattern(pattern, urlString) {
  /*
    var patter = 'name.js';
    var pattern = /name/;

    // and rules
    var pattern = {
      hostname: 'baidu.com',
      pathname: '',
    }

    // or rules
    var pattern = [
    {
      hostname: /baidu.com/
    }
    ];

  */
  var urlComponents = url.parse(urlString);
  var andRule = {};
  var orRule = {};
  switch(typeof pattern) {
    case 'string':
    case 'RegExp':
    case 'Array': {
      log.debug('typeof pattern: ' + typeof pattern);
      _buildRule(pattern, andRule);
      break;
    }
    case 'object': {
      _buildRule(pattern, orRule);
      break;
    }
    default: {
      break;
    }
  }

  log.debug('andRule: ' + JSON.stringify(andRule));
  log.debug('orRule: ' + JSON.stringify(orRule));
  log.debug('urlComponents: ' + JSON.stringify(urlComponents));

  if (Object.keys(andRule).length > 0) {
    for(var k in andRule) {

      console.log('andRule, key: %s, rule: %s, url component: %s', 
          k, andRule[k], urlComponents[k]);

      var reg = new RegExp(andRule[k]);
      console.log(reg, reg.test(urlComponents[k]));
      
      if (!reg.test(urlComponents[k])) {
          log.debug('andRule not matched');
          return false;
      }
    }
    log.debug('andRule matched, rule: %s, ');
    return true;

  } else if (Object.keys(orRule).length > 0) {
    for(var k in orRule) {
      console.log(k);
      var reg = new RegExp(orRule[k]);
      console.log(reg + '');
      if (reg.test(urlComponents[k])) {
          log.debug('orRule matched');
          log.debug('matched, orRule: ' + orRule[k] + ', urlComponents: ' + urlComponents[k]);
          return true;
      }
    }
    log.debug('orRule not matched');
    return false;

  } else {
    return false;
  }
}

function _buildRule(pattern, rule) {
  switch(typeof pattern) {
    case 'string':
    case 'RegExp': {
      rule['href'] = pattern;
      break;
    }
    case 'object': {
      for (var k in pattern) {
        rule[k] = pattern[k];
      }
      break;
    }
    case 'Array': {
      for(var i in pattern) {
        _buildRule(pattern[i], rule)
      }
    }
    default:
      break;
  }
}

module.exports = respond;

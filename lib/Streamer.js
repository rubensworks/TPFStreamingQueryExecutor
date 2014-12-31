/**
 * This module is responsible for the query execution.
 * It will filter out all current dynamic result and fill them in into the static query.
 * That query will then be executed or gotten from the cache and returned to the client.
 */

var timeUtil = require('./TimeUtils.js'),
    Composer = require('./SparqlComposer.js'),
    util     = require('./RdfUtils.js'),
    clc      = require('cli-color'); // TODO: remove, only for easy debugging

var debugMode = !!process.env.DEBUG;

function Streamer(ldf, target, originalVariables, durationCallback) {
  if (!(this instanceof Streamer))
    return new Streamer(ldf, target, originalVariables);

  this._ldf               = ldf;
  this._target            = target;
  this._originalVariables = originalVariables;
  this._durationCallback  = durationCallback;
}

/**
 * Start query execution.
 * @param context The context received from the rewriter with an extra cache element.
 * @param callback The result callback.
 * @param calledAt The moment one query was executed.
 */
Streamer.prototype.executeQuery = function(context, callback, calledAt) {
  this._debug(function() {
    console.log("Result: " + context.counter++ + "\n------\n");
  });
  this.fragmentsClient = new this._ldf.FragmentsClient(this._target);
  var results           = new this._ldf.SparqlIterator(context.dynamicQuery, { fragmentsClient: this.fragmentsClient }),
    self              = this,
    resultUpdateTimes = {},
    barrierCount      = 1; // Decremented on dynamic result, incremented on static result and incremented at dynamic end.
  context.updateAt = false;
  results.on('data', function (row) {
    if(timeUtil.areAllCurrent(row, calledAt, self._taCounter)) {
      // Determine new update time
      var thisUpdateTime = timeUtil.getMinimumUpdateTime(row, self._taCounter);
      barrierCount--;

      // Get the static data for this row from cache or execute new query.
      self._populateStaticdata(context, row, context.intersectedVariables, Object.clone(context.staticHolder, true), context.cache,
        function(results) {
          results.forEach(function(result) {
            var out = {};
            var resultHash = "";

            // Determine output
            self._originalVariables.forEach(function(variable) {
              resultHash += variable + "=" + result[variable];
              out[variable] = result[variable];
            });

            if(!resultUpdateTimes[resultHash] || !context.distinct) {
              // Send the callback if it has not been sent before (or if DISTINCT was not specified)

              // Flush
              callback(out, context.counter);

              // Mark result as 'sent' in cache
              resultUpdateTimes[resultHash] = thisUpdateTime;

              // Set update at
              context.updateAt = timeUtil.replaceUpdateTime(context.updateAt, thisUpdateTime);
            } else {
              // If the results were already sent, the updateAt could still be changed if this new result has a LATER updateTime
              // than the one stored for this result.

              if(resultUpdateTimes[resultHash] < thisUpdateTime) {
                resultUpdateTimes[resultHash] = thisUpdateTime;
                context.updateAt = timeUtil.replaceUpdateTime(context.updateAt, thisUpdateTime);
              }
            }
          });
          endQueryBarrier();
        });

    }
  });
  results.on('end', endQueryBarrier);
  results.on('error', function(e) {
    console.log("Error while streaming! " + e);
  });

  /**
   * End function for the query that requires two calls before it can be executed.
   * This is to make sure the static AND dynamic parts have ended.
   */
  function endQueryBarrier() {
    barrierCount++;
    if(barrierCount == 2) {
      var currentTime = timeUtil.getTime();
      var duration = currentTime - calledAt;
      self._durationCallback(duration);
      self._debug(function() {
        console.log(clc.green("Client request time: " + duration / 1000 + " seconds"));
      });
      if(context.hasTimeAnnotation) {
        if(!context.updateAt) {
          context.updateAt = currentTime;
        }
        var timeOut = context.updateAt - currentTime;
        if(timeOut <= 0) {
          timeOut = 1000;
          self._debug(function() {
            console.log("Second skipping...");
          });
        } else {
          self._debug(function() {
            console.log("Will update in: " + timeOut / 1000 + "s");
          });
        }
        setTimeout(function() {
          self.executeQuery(context, callback, timeUtil.getTime());
        }, timeOut);
      } else {
        console.log("No valid context time found, stopping.");
      }
    }
  }
};

/**
 * Fill in the queryHolder with materialized variables in row.
 * Only the variables in intersectedVariables will be filled in.
 */
Streamer.prototype._bindVariablesQuery = function(row, disjointVariables, queryHolder) {
  // TODO: move this first part to preprocess, just a small optimization
  disjointVariables.forEach(function(variable) {
    var index = queryHolder.variables.indexOf(variable);
    if(index > -1) {
      queryHolder.variables.splice(index, 1);
    }
  });
  this._bindVariablesQueryPart(row, disjointVariables, queryHolder.where);
};

/**
 * Fill in the queryHolder where clause with materialized variables in row.
 * Only the variables in intersectedVariables will be filled in.
 */
Streamer.prototype._bindVariablesQueryPart = function(row, disjointVariables, queryPart) {
  var self = this;
  if(queryPart instanceof Array) {
    queryPart.forEach(function(el) { self._bindVariablesQueryPart(row, disjointVariables, el); });
  } else if(queryPart.type == "bgp") {
    this._bindVariablesQueryPart(row, disjointVariables, queryPart.triples);
  } else if(queryPart.type == "union") {
    this._bindVariablesQueryPart(row, disjointVariables, queryPart.patterns);
  } else {
    util.fields.forEach(function(field) {
      disjointVariables.forEach(function(variable) {
        if(queryPart[field] == variable) {
          queryPart[field] = "<" + row[variable] + ">";
        }
      });
    });
  }
};

/**
 * Merge the given dynamic query results with static data that corresponds to the staticHolder.
 * Either the cached data will be used, or a new query will be executed to fetch that static data and it will be cached
 * afterwards.
 */
Streamer.prototype._populateStaticdata = function(context, row, disjointVariables, staticHolder, cache, callback) {
  if(!context.staticStep) {
    callback([row]);
  } else {
    var key = generateCacheKey(row, disjointVariables);

    if (cache.hasKey(key)) {
      mergeResults(row, cache.get(key), callback);
    } else {
      var staticResults = [];

      // Replace the dynamic variables inside the static query.
      this._bindVariablesQuery(row, disjointVariables, staticHolder);

      // Fetch static results
      var results = new this._ldf.SparqlIterator(new Composer(staticHolder).compose(), { fragmentsClient: this.fragmentsClient });
      results.on('data', function (row) {
        staticResults.push(row);
      });
      results.on('end', function () {
        cache.put(key, staticResults);
        mergeResults(row, staticResults, callback);
      });
      results.on('error', function (e) {
        console.log("Error while streaming! " + e);
      });
    }
  }

  /**
   * Send the merge of static and dynamic results to the calback.
   */
  function mergeResults(row, staticResults, callback) {
    callback(staticResults.map(function(staticResult) {
      return util.concatMap(row, staticResult);
    }));
  }

  /**
   * Generate a key for the cache given.
   */
  function generateCacheKey(row, disjointVariables) {
    return disjointVariables.reduce(function(key, variable) {
      return key + variable + "=\"" + row[variable] + "\"";
    }, "");
  }
};

Streamer.prototype._debug = function(callback) {
  debugMode && callback();
};

module.exports = Streamer;
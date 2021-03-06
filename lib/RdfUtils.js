var N3 = require('n3');

var INTERVAL = process.env.INTERVAL == "true";

/**
 * Utility functions for working with URIs, triples, variables, and patterns.
 * @exports RdfUtil
 * @extends N3.Util
 */
var util = module.exports = N3.Util({});

util.prefixes = {
    "rdf":  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "t":    "http://example.org/tracks#",
    "a":    "http://example.org/artists#",
    "m":    "http://example.org/music#",
    "radio":"http://example.org/radios#",
    "tmp":  "http://example.org/temporal#",
    "sp":  "http://example.org/singletonproperties#",
    "graphs":  "http://example.org/graphs#",
    "train":"http://example.org/train#",
    "departure": "http://irail.be/stations/NMBS/008892007/departures/",
    "stop": "http://irail.be/stations/NMBS/",
};
util.suffixes = {
    "timestamp": "xsd:dateTimeStamp",
};
util.fields = ["subject", "predicate", "object", "context"];
var statementCounter = 0;
var spStatementCounter = 0;

/**
 * Check if the given field is a variable.
 */
util.isVariable = function(field) {
  return field && field.charAt(0) == '?';
};

/**
 * Check if the given field is a blank node.
 */
util.isBlankNode = function(field) {
  return field && field.charAt(0) == '_';
};

/**
 * Create a triple object.
 */
util.triple = function(subject, predicate, object) {
    return { subject: subject, predicate: predicate, object: object };
};

/**
 * Create a quad object.
 */
util.quad = function(subject, predicate, object, context) {
  return { subject: subject, predicate: predicate, object: object, context: context };
};

/**
 * Create a blank node object. Triple object without subject.
 */
util.blankNode = function(predicate, object) {
    return { predicate: predicate, object: object };
};

/**
 * Add a suffix to an object to make it a literal.
 */
util.addSuffix = function(object, suffix) {
    return "\"" + object + "\"^^" + suffix;
};

/**
 * Create a new blank node label.
 * @param callback A callback function that takes a label as argument.
 * @returns {string} The created label
 */
util.blankNodeContext = function(callback) {
    var label = "_:stmt" + statementCounter++;
    callback && callback(label);
    return label;
};

/**
 * Create annotation parameters for a time-interval.
 */
util.createInterval = function(initial, final) {
    return [
        util.blankNode(util.prefixes.tmp + "intervalInitial", util.addSuffix(initial, util.suffixes.timestamp)),
        util.blankNode(util.prefixes.tmp + "intervalFinal", util.addSuffix(final, util.suffixes.timestamp)),
    ];
};

/**
 * Writes a blank node to the writer.
 * @param writer N3 writer.
 * @param blankNodeData A list of blank node data (predicates and objects), ex: [{predicate: "a", object: "b"}]
 *                      The object can be a list of blank nodes as well, so nested blank nodes are allowed.
 * @param customLabel An optional custom label for the subjects.
 */
util.writeBlankNode = function(writer, blankNodeData, customLabel) {
    return util.blankNodeContext(function(label) {
        label = customLabel || label;
        for(var i = 0; i < blankNodeData.length; i++) {
            var object = blankNodeData[i].object;
            if(object instanceof Array && object.length > 0) {
                object = util.writeBlankNode(writer, object);
            }
            writer.addTriple(util.triple(label, blankNodeData[i].predicate, object));
        }
    });
};

/**
 * Reify the given triple and write it to the writer.
 * @param writer The writer.
 * @param intriple The triple to reify.
 * @param params An optional list of blank nodes to add as annotations.
 */
util.writeReification = function(writer, intriple, params) {
    util.writeBlankNode(writer, util.reifyBlank(intriple).concat(params || []));
};

/**
 * Reify the given triple without a subject.
 * @param intriple The triple to reify.
 */
util.reifyBlank = function(intriple) {
    return [
        util.blankNode(util.prefixes.rdf + "subject", intriple.subject),
        util.blankNode(util.prefixes.rdf + "predicate", intriple.predicate),
        util.blankNode(util.prefixes.rdf + "object", intriple.object),
    ];
};

/**
 * Reify the given triple.
 * @param intriple The triple to reify.
 */
util.reify = function(intriple) {
    var label = util.blankNodeContext();
    return [
        util.triple(label, util.prefixes.rdf + "subject", intriple.subject),
        util.triple(label, util.prefixes.rdf + "predicate", intriple.predicate),
        util.triple(label, util.prefixes.rdf + "object", intriple.object),
    ];
};

/**
 * Transform the given triple to a singleton properties equivalent.
 * @param intriple The triple to transform.
 */
util.makeSingletonProperty = function(intriple) {
    var label = "?sp" + spStatementCounter++;
    return [
        util.triple(label, util.prefixes.sp + "singletonPropertyOf", intriple.predicate),
        util.triple(intriple.subject, label, intriple.object),
    ];
};

/**
 * Time annotate the given triple(s), first triple subject will be taken as label.
 * @param triples The input triples to append to.
 * @param customSubject An optional subject instead of the one from the first triple.
 * @param taCounterCallback An optional callback for determining a suffix for the initial and final variables
 * @returns The accumulated triples
 */
util.timeAnnotate = function(triples, customSubject, taCounterCallback) {
    var subject = customSubject || triples[0].subject;
    var varSuffix = taCounterCallback ? taCounterCallback() : "";
    if(INTERVAL) {
      triples = triples.concat([
        util.triple(subject, "tmp:intervalInitial", "?initial" + varSuffix),
        util.triple(subject, "tmp:intervalFinal", "?final" + varSuffix)
      ]);
    } else {
      triples = triples.concat([
        util.triple(subject, "tmp:expiration", "?final" + varSuffix)
      ]);
    }
    return triples;
};

/**
 * Reify the given triple with time annotation.
 * @param intriple The triple to reify.
 * @param taCounterCallback An optional callback for determining a suffix for the initial and final variables
 */
util.timeAnnotatedReification = function(intriple, taCounterCallback) {
    return util.timeAnnotate(util.reify(intriple), false, taCounterCallback);
};

/**
 * Transform the given triple to singleton properties with time annotation.
 * @param intriple The triple to transform.
 * @param taCounterCallback An optional callback for determining a suffix for the initial and final variables
 */
util.timeAnnotatedSingletonProperties = function(intriple, taCounterCallback) {
    return util.timeAnnotate(util.makeSingletonProperty(intriple), false, taCounterCallback);
};

/**
 * Transform the given triple to a quad with time annotation.
 * @param intriple The triple to transform.
 * @param taCounterCallback An optional callback for determining a suffix for the initial and final variables
 */
util.timeAnnotatedQuads = function(intriple, taCounterCallback) {
  var label = util.blankNodeContext();
  label = "?" + label.substr(2, label.length);
  return util.timeAnnotate([util.quad(intriple.subject, intriple.predicate, intriple.object, label)], label, taCounterCallback);
};

/**
 * No operation for time annotation.
 * @param intriple The triple to transform.
 * @param taCounterCallback An optional callback for determining a suffix for the initial and final variables
 */
util.timeAnnotatedNoop = function(intriple, taCounterCallback) {
  return intriple;
};

/**
 * Merge two maps into a new one.
 */
util.concatMap = function(map1, map2) {
  var newMap = {}, attrName;
  for (attrName in map1) { newMap[attrName] = map1[attrName]; }
  for (attrName in map2) { newMap[attrName] = map2[attrName]; }
  return newMap;
};

/**
 * Find the intersection of two arrays.
 * Arrays are not sorted, so the complexity is be O(n^2)
 * Arrays are assumed to be sets.
 * @param array1
 * @param array2
 * @returns {Array}
 */
util.intersection = function(array1, array2) {
  var newArray = [];
  array1.forEach(function(el1) {
    array2.forEach(function(el2) {
      if(el1 == el2) newArray.push(el1);
    });
  });
  return newArray;
};

/**
 * Reduct the second array from the first array.
 * Arrays are not sorted, so the complexity is be O(n^2)
 * Arrays are assumed to be sets.
 * @param array1 Reduct from
 * @param array2 Reduct
 * @returns {Array}
 */
util.reduction = function(array1, array2) {
  var newArray = [];
  array1.forEach(function(el1) {
    var shouldAdd = true;
    array2.forEach(function(el2) {
      if(el1 == el2) shouldAdd = false;
    });
    shouldAdd && newArray.push(el1);
  });
  return newArray;
};

/**
 * Get the full IRI of a triple.
 * @param IRIPrefix The prefix of the triple.
 * @param s Subject
 * @param p Predicate
 * @param o Object
 * @returns {string} The full IRI.
 */
util.tripleToIRI = function(IRIPrefix, s, p, o, skipTags) {
  if(!p) {
    o = s.object;
    p = s.predicate;
    s = s.subject;
  }
  return (!skipTags ? "<" : "") + IRIPrefix + "?subject=" + encodeURI(s) + "&predicate=" + encodeURI(p) + "&object=" + encodeURI(o) + (!skipTags ? ">" : "");
};

/**
 * Get a list of all variables in a triple.
 * @param triple The triple.
 * @returns {Array} The variables.
 */
util.getVariables = function(triple) {
  var variables = [];
  util.fields.forEach(function(field) {
    if(util.isVariable(triple[field])) {
      variables.push(triple[field]);
    }
  });
  return variables;
};

/**
 * Bind the given triple, mutable.
 * @param triple The triple, mutable.
 * @param bindings The bindings.
 */
util.bindVariables = function(triple, bindings) {
  util.fields.forEach(function(field) {
    var value = triple[field];
    if(util.isVariable(value) && bindings[value]) {
      triple[field] = bindings[value];
    }
  });
};

/**
 * Find the bindings of the implicit graph identificator and check if at least one of them is time annotated.
 * @param bindings bindings
 * @param triple The triple identifying the graph, variables are allowed.
 * @param prefixes The prefixes.
 * @param target The target URI.
 * @param taCounterCallback Optional counter callback.
 */
util.materializedImplicitGraphQuery = function(bindings, triple, prefixes, target, taCounterCallback) {
  var boundTriple = Object.clone(triple, true);
  util.bindVariables(boundTriple, bindings);
  return this._implicitGraphQuery(boundTriple, prefixes, target, taCounterCallback);
};

/**
 * Construct a query for the given triple that will be used as subject to get the time annotation from.
 * @param triple The triple that acts as an implicit graph identificator.
 * @param prefixes The prefixes to add.
 * @param target The target URI.
 * @param taCounterCallback Optional counter callback.
 * @private
 */
util._implicitGraphQuery = function(triple, prefixes, target, taCounterCallback) {
  return this.singularQuery(util.timeAnnotate([], util.tripleToIRI(target, triple), taCounterCallback), prefixes);
};

/**
 * Construct a query with a list of triples.
 * @param triples The triples.
 * @param prefixes The prefixes to add.
 */
util.singularQuery = function(triples, prefixes) {
  var query = {
    "type": "query",
    "prefixes": this.extendObject({
      "tmp": util.prefixes.tmp,
      "sp": util.prefixes.sp
    }, prefixes),
    "queryType": "SELECT",
    "variables": triples.reduce(function(prev, triple) { return prev.concat(util.getVariables(triple)); }, []),
    "where": [
      {
        "type": "bgp",
        "triples": triples,
      }
    ]
  };
  return query;
};

/**
 * Copy all properties from the source to the self object.
 */
util.extendObject = function(self, source) {
  for (var property in source) {
    if (source.hasOwnProperty(property)) {
      self[property] = source[property];
    }
  }
  return self;
};

/**
 * Execute a query, returns the result object.
 */
util.executeQuery = function(ldf, target, query) {
  var fragmentsClient = new ldf.FragmentsClient(target);
  return new ldf.SparqlIterator(query, { fragmentsClient: fragmentsClient });
};

Object.freeze(util);
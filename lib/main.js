/*
 * Copyright 2015-2016 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const colors = require('colors'),
      package = require('../package.json'),
      argv = require('argv').version(package.version),
      columnify = require('columnify'),
      expandHomeDir = require('expand-home-dir'),
      propertiesParser = require('properties-parser'),
      wskprops = propertiesParser.read(process.env.WSK_CONFIG_FILE || expandHomeDir('~/.wskprops')),
      owProps = {
	  apihost: wskprops.APIHOST || 'openwhisk.ng.bluemix.net',
	  api_key: wskprops.AUTH,
	  namespace: wskprops.NAMESPACE || '_',
	  ignore_certs: process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0"
      },
      ow = require('openwhisk')(owProps),
      options = argv.option([
	  {name: 'kind', short: 'k', type: 'string', description: 'View only a selected kind of entity; e.g. --kind=[rule|action|sequence]'},
	  {name: 'limit', short: 'l', type: 'string', description: 'Specify a numerical limit, e.g. --limit=200'},
	  {name: 'debug', short: 'd', type: 'string', description: 'Debug mode'},
	  {name: 'extensive-debug', short: 'e', type: 'string', description: 'Debug mode'},
	  {name: 'wide', short: 'w', type: 'string', description: 'Widen the columns'},
	  {name: 'garbage-only', short: 'g', type: 'string', description: 'Show only entities that reference deleted entities'},
	  {name: 'gc', type: 'string', description: 'Exclude entities that reference deleted entities'},
	  {name: 'full-width', short: 'f', type: 'string', description: 'Use full-width columns'}
      ]).run().options

function debug(message) {
    if (options.debug || options['extensive-debug']) {
	console.log('DEBUG'.red + ' ' + message)
    }
}
function debugDeeply(message, struct) {
    if (options['extensive-debug']) {
	console.log('DEBUG'.red + ' ' + message + ' ' + JSON.stringify(struct))
    }
}

debug(`owProps=${JSON.stringify(owProps)}`)

/**
 * Pretty printers
 *
 */
const deleted = name => `!!(${name})`.red.dim
const pp = name => name && (name.split('/').slice(2).join('.') || name)
const pps = action => !action.exec || action.exec.kind !== 'sequence' ? pp(action.name) || deleted(action)
      : action.exec.components
            .slice(1)
            .reduce((S, c) => `${S} -> ${pp(c)}`, pp(action.exec.components[0])).green
const ppf = (feed, trigger) => feed ? pp(feed).blue + `(${trigger.name})` : trigger.name || deleted(trigger)
const ppt = trigger => ppf(((trigger.annotations || []).find(a => a.key === 'feed') || { value: '' }).value, trigger)

/**
 * Turn an array into a map
 *
 */
const toMap = L => L.reduce((M, entity) => { M[entity.name] = entity; return M; }, {})

/**
 * Form an openwhisk entity query
 *
 */
const query = (entity, kind) => {
    const Q = {}
    Q[(kind || 'action') + 'Name'] = entity.name
    Q.namespace = entity.namespace

    return Q
}

/**
 * Perform an openwisk "get" call on the entities in a given list L
 *
 */
const get = (L, kind) => {
    return Promise.all(L.map(entity => ow[(kind || 'action') + 's'].get(query(entity, kind))))
}

/**
 * This is the main view generator
 *
 */
const view = (triggers, actions, rules) => {
    try {
	debug(`Viewer got ${triggers.length} triggers`)
	debug(`Viewer got ${actions.length} actions`)
	debug(`Viewer got ${rules.length} rules`)

	Promise.all([ get(triggers, 'trigger'), get(actions), get(rules, 'rule') ])
	    .then(viewWithDetails)
    } catch (e) {
	console.error(e)
    }
}

/**
 * This is the view generator that assumes the entity details have
 * been fetched
 *
 * @param A = [triggers, actions, rules]
 *
 */
const viewWithDetails = A => {
    try {
	const triggers = A[0]
	const actions = A[1]
	const rules = A[2]
	debug(`Viewer got details for ${triggers.length} triggers`)
	debug(`Viewer got details for ${actions.length} actions`)
	debug(`Viewer got details for ${rules.length} rules`)

	var triggerMap = toMap(triggers)
	var actionMap = toMap(actions)
	var data = []

	rules.forEach(rule => {
	    const triggerExists = triggerMap[rule.trigger] !== undefined
	    const actionExists = actionMap[rule.action] !== undefined
	    const include = (options.gc && triggerExists && actionExists)
		  || (options['garbage-only'] && (!triggerExists || !actionExists))
		  || (!options.gc && !options['garbage-only'])
	    if (include) {
		data.push({
		    structure: `${ppt(triggerMap[rule.trigger] || rule.trigger)} => `
			+ pps(actionMap[rule.action] || rule.action),
		    type: 'rule'.reset,
		    name: rule.name
		})
	    
		delete actionMap[rule.action]
	    }
	})

	if (!options.kind || options.kind == 'action' || options.kind == 'actions' || options.kind == 'a') {
	    debugDeeply('actionMap', actionMap)
	    
	    for (var actionName in actionMap) {
		const action = actionMap[actionName]
		const actionExists = action !== undefined
		
		const include = (options.gc && actionExists)
		      || (options['garbage-only'] && !actionExists)
		      || (!options.gc && !options['garbage-only'])
		
		if (include) {
		    if (action.exec.kind === 'sequence') {
			data.push({
			    structure: pps(action),
			    type: 'sequence'.reset,
			    name: action.name
			})
		    } else {
			data.push({
			    structure: action.exec && action.exec.kind,
			    type: 'action'.reset,
			    name: action.name
			})
		    }
		}
	    }
	}

	if (data.length > 0) {
	    data.sort((a,b) => b.type.localeCompare(a.type))
	    debugDeeply('data', data)

	    const columnOpts = { minWidth: 8, truncate: true }
	    if (!options['full-width']) {
		columnOpts.maxWidth = options.wide ? 80 : 40
	    }
	    console.log(columnify(data, columnOpts))
	}
    } catch (e) {
	console.error(e)
    }
}

/**
 * Process the command line options, and then fetch data and invoke
 * the viewer as appropriate
 *
 */
function main() {
    const listOptions = { limit: options.limit || 20 }
    
    if (options.kind) {
	switch (options.kind) {
	case 'actions': case 'action': case 'a': case 'act':
	    debug('Viewing actions')
	    return ow.actions.list(listOptions)
		.then(actions => view([], actions, []))
	case 'rules': case 'rule': case 'r':
	    debug('Viewing rules')
	    return ow.rules.list(listOptions)
		.then(rules =>
		      ow.triggers.list(listOptions)
		      .then(triggers => view(triggers, [], rules)))
	}
    } else {
	debug('Viewing all entities')
	ow.actions.list(listOptions)
	    .then(actions => ow.rules.list(listOptions)
		  .then(rules => ow.triggers.list(listOptions)
			.then(triggers => view(triggers, actions, rules))))
    }
}

module.exports.main = main

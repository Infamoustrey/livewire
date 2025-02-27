import { dispatch, dispatchSelf, dispatchTo, listen } from '@/features/supportEvents'
import { generateEntangleFunction } from '@/features/supportEntangle'
import { closestComponent, findComponent } from '@/store'
import { requestCommit, requestCall } from '@/commit'
import { WeakBag, dataGet, dataSet } from '@/utils'
import { on, trigger } from '@/events'
import Alpine from 'alpinejs'
import { removeUpload, upload, uploadMultiple } from './features/supportFileUploads'

let properties = {}
let fallback

function wireProperty(name, callback, component = null) {
    properties[name] = callback
}

function wireFallback(callback) {
    fallback = callback
}

// For V2 backwards compatibility...
// And I actually like both depending on the scenario...
let aliases = {
    'get': '$get',
    'set': '$set',
    'call': '$call',
    'commit': '$commit',
    'watch': '$watch',
    'entangle': '$entangle',
    'dispatch': '$dispatch',
    'dispatchTo': '$dispatchTo',
    'dispatchSelf': '$dispatchSelf',
    'upload': '$upload',
    'uploadMultiple': '$uploadMultiple',
    'removeUpload': '$removeUpload',
}

export function generateWireObject(component, state) {
    return new Proxy({}, {
        get(target, property) {
            if (property === '__instance') return component

            if (property in aliases) {
                return getProperty(component, aliases[property])
            } else if (property in properties) {
                return getProperty(component, property)
            } else if (property in state) {
                return state[property]
            } else if (! ['then'].includes(property)) {
                return getFallback(component)(property)
            }
        },

        set(target, property, value) {
            if (property in state) {
                state[property] = value
            }

            return true
        },
    })
}

function getProperty(component, name) {
    return properties[name](component)
}

function getFallback(component) {
    return fallback(component)
}

Alpine.magic('wire', el => closestComponent(el).$wire)

wireProperty('__instance', (component) => component)

wireProperty('$get', (component) => (property, reactive = true) => dataGet(reactive ? component.reactive : component.ephemeral, property))

wireProperty('$set', (component) => async (property, value, live = true) => {
    dataSet(component.reactive, property, value)

    return live
        ? await requestCommit(component)
        : Promise.resolve()
})

wireProperty('$call', (component) => async (method, ...params) => {
    return await component.$wire[method](...params)
})

wireProperty('$entangle', (component) => (name, live = false) => {
    return generateEntangleFunction(component)(name, live)
})

wireProperty('$toggle', (component) => (name) => {
    return component.$wire.set(name, ! component.$wire.get(name))
})

wireProperty('$watch', (component) => (path, callback) => {
    let firstTime = true
    let oldValue = undefined

   Alpine.effect(() => {
    // JSON.stringify touches every single property at any level enabling deep watching
        let value = dataGet(component.reactive, path)
        JSON.stringify(value)

        if (! firstTime) {
            // We have to queue this watcher as a microtask so that
            // the watcher doesn't pick up its own dependencies.
            queueMicrotask(() => {
                callback(value, oldValue)

                oldValue = value
            })
        } else {
            oldValue = value
        }

        firstTime = false
    })
})

wireProperty('$refresh', (component) => component.$wire.$commit)
wireProperty('$commit', (component) => async () => await requestCommit(component))

wireProperty('$on', (component) => (...params) => listen(component, ...params))

wireProperty('$dispatch', (component) => (...params) => dispatch(component, ...params))
wireProperty('$dispatchSelf', (component) => (...params) => dispatchSelf(component, ...params))
wireProperty('$dispatchTo', (component) => (...params) => dispatchTo(component, ...params))

wireProperty('$upload', (component) => (...params) => upload(component, ...params))
wireProperty('$uploadMultiple', (component) => (...params) => uploadMultiple(component, ...params))
wireProperty('$removeUpload', (component) => (...params) => removeUpload(component, ...params))

let parentMemo

wireProperty('$parent', component => {
    if (parentMemo) return parentMemo.$wire

    let parent = closestComponent(component.el.parentElement)

    parentMemo = parent

    return parent.$wire
})


let overriddenMethods = new WeakMap

export function overrideMethod(component, method, callback) {
    if (! overriddenMethods.has(component)) {
        overriddenMethods.set(component, {})
    }

    let obj = overriddenMethods.get(component)

    obj[method] = callback

    overriddenMethods.set(component, obj)
}

wireFallback((component) => (property) => async (...params) => {
    // If this method is passed directly to a Vue or Alpine
    // event listener (@click="someMethod") without using
    // parens, strip out the automatically added event.
    if (params.length === 1 && params[0] instanceof Event) {
        params = []
    }

    if (overriddenMethods.has(component)) {
        let overrides = overriddenMethods.get(component)

        if (typeof overrides[property] === 'function') {
            return overrides[property](params)
        }
    }

    return await requestCall(component, property, params)
})

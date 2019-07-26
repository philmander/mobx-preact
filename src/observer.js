import { _getGlobalState, createAtom, Reaction } from 'mobx';
import { Component, toChildArray } from 'preact';
import { isStateless, makeDisplayName } from './utils/utils';

let isUsingStaticRendering = false;

const logger = console; // eslint-disable-line no-console

export function useStaticRendering(useStaticRendering) {
    isUsingStaticRendering = useStaticRendering;
}

/**
 Workaround

 allowStateChanges from mobX must be patched so that props, state and args are passed to the render() function
 */

function allowStateChangesStart(allowStateChanges) {
    const prev = _getGlobalState().allowStateChanges;
    _getGlobalState().allowStateChanges = allowStateChanges;
    return prev;
}

function allowStateChangesEnd(prev) {
    _getGlobalState().allowStateChanges = prev;
}

function allowStateChanges(allowStateChanges, func, props, state, context) {
    const prev = allowStateChangesStart(allowStateChanges);
    let res;
    try {
        res = func(props, state, context);
    } finally {
        allowStateChangesEnd(prev);
    }
    return res;
}

/**
 * Utilities
 */

function patch(target, funcName, runMixinFirst = false) {
    const base = target[funcName];
    const mixinFunc = reactiveMixin[funcName];
    // MWE: ideally we freeze here to protect against accidental overwrites in component instances, see #195
    // ...but that breaks react-hot-loader, see #231...
    target[funcName] = !base
        ? mixinFunc
        : runMixinFirst === true
            ? function () {
                mixinFunc.apply(this, arguments);
                base.apply(this, arguments);
            }
            : function () {
                base.apply(this, arguments);
                mixinFunc.apply(this, arguments);
            };
}

function isObjectShallowModified(prev, next) {
    if (null == prev || null == next || typeof prev !== 'object' || typeof next !== 'object') {
        return prev !== next;
    }
    const keys = Object.keys(prev);
    if (keys.length !== Object.keys(next).length) {
        return true;
    }
    let key;
    for (let i = keys.length - 1; i >= 0, (key = keys[i]); i--) {
        if (next[key] !== prev[key]) {
            return true;
        }
    }
    return false;
}

/**
 * ReactiveMixin
 */
const reactiveMixin = {
    componentWillMount: function () {
        if (isUsingStaticRendering === true) {
            return;
        }
        // Generate friendly name for debugging
        const initialName = makeDisplayName(this);

        /**
         * If props are shallowly modified, react will render anyway,
         * so atom.reportChanged() should not result in yet another re-render
         */
        let skipRender = false;
        /**
         * forceUpdate will re-assign this.props. We don't want that to cause a loop,
         * so detect these changes
         */
        let isForcingUpdate = false;

        function makePropertyObservableReference(propName) {
            let valueHolder = this[propName];
            const atom = createAtom('reactive ' + propName);
            Object.defineProperty(this, propName, {
                configurable: true,
                enumerable: true,
                get: function () {
                    atom.reportObserved();
                    return valueHolder;
                },
                set: function set(v) {
                    if (!isForcingUpdate && isObjectShallowModified(valueHolder, v)) {
                        valueHolder = v;
                        skipRender = true;
                        atom.reportChanged();
                        skipRender = false;
                    } else {
                        valueHolder = v;
                    }
                },
            });
        }

        // make this.props an observable reference, see #124
        makePropertyObservableReference.call(this, 'props');
        // make state an observable reference
        makePropertyObservableReference.call(this, 'state');

        // wire up reactive render
        const baseRender = this.render.bind(this);
        let reaction = null;
        let isRenderingPending = false;

        const initialRender = () => {
            reaction = new Reaction(`${initialName}.render()`, () => {
                if (!isRenderingPending) {
                    // N.B. Getting here *before mounting* means that a component constructor has side effects (see the relevant test in misc.js)
                    // This unidiomatic React usage but React will correctly warn about this so we continue as usual
                    // See #85 / Pull #44
                    isRenderingPending = true;
                    if (typeof this.componentWillReact === 'function') {
                        this.componentWillReact();
                    } // TODO: wrap in action?
                    if (this.__$mobxIsUnmounted !== true) {
                        // If we are unmounted at this point, componentWillReact() had a side effect causing the component to unmounted
                        // TODO: remove this check? Then react will properly warn about the fact that this should not happen? See #73
                        // However, people also claim this migth happen during unit tests..
                        let hasError = true;
                        try {
                            isForcingUpdate = true;
                            if (!skipRender) {
                                Component.prototype.forceUpdate.call(this);
                            }
                            hasError = false;
                        } finally {
                            isForcingUpdate = false;
                            if (hasError) {
                                reaction.dispose();
                            }
                        }
                    }
                }
            });
            reaction.reactComponent = this;
            reactiveRender.$mobx = reaction;
            this.render = reactiveRender;
            return reactiveRender(this.props, this.state, this.context);
        };

        const reactiveRender = (props, state, context) => {
            isRenderingPending = false;
            let exception = undefined;
            let rendering = undefined;
            reaction.track(() => {
                try {
                    rendering = allowStateChanges(false, baseRender, props, state, context);
                } catch (e) {
                    exception = e;
                }
            });
            if (exception) {
                throw exception;
            }
            return rendering;
        };

        this.render = initialRender;
    },

    componentWillUnmount: function () {
        if (isUsingStaticRendering === true) {
            return;
        }
        this.render.$mobx && this.render.$mobx.dispose();
        this.__$mobxIsUnmounted = true;
    },

    componentDidMount: function () {
    },

    componentDidUpdate: function () {
    },

    shouldComponentUpdate: function (nextProps, nextState) {
        if (isUsingStaticRendering) {
            logger.warn(
                '[mobx-preact] It seems that a re-rendering of a React component is triggered while in static (server-side) mode. Please make sure components are rendered only once server-side.',
            );
        }
        // update on any state changes (as is the default)
        if (this.state !== nextState) {
            return true;
        }
        // update if props are shallowly not equal, inspired by PureRenderMixin
        // we could return just 'false' here, and avoid the `skipRender` checks etc
        // however, it is nicer if lifecycle events are triggered like usually,
        // so we return true here if props are shallowly modified.
        return isObjectShallowModified(this.props, nextProps);
    },
};

/**
 * Observer function / decorator
 */
export function observer(componentClass) {
    if (arguments.length > 1) {
        logger.warn(
            'Mobx observer: Using observer to inject stores is not supported. ' +
            'Use `@connect(["store1", "store2"]) ComponentClass instead or preferably, ' +
            'use `@inject("store1", "store2") @observer ComponentClass` or `inject("store1", "store2")(observer(componentClass))``',
        );
    }

    if (componentClass.isMobxInjector === true) {
        logger.warn(
            'Mobx observer: You are trying to use \'observer\' on a component that already has \'inject\'. ' +
            'Please apply \'observer\' before applying \'inject\'',
        );
    }

    // Stateless function component:
    if (isStateless(componentClass)) {
        // noinspection TailRecursionJS
        return observer(
            class extends Component {
                static displayName = makeDisplayName(componentClass);

                render() {
                    return componentClass.call(this, this.props, this.context);
                }
            },
        );
    }

    if (!componentClass) {
        throw new Error('Please pass a valid component to \'observer\'');
    }

    const target = componentClass.prototype || componentClass;
    mixinLifecycleEvents(target);
    componentClass.isMobXReactObserver = true;
    return componentClass;
}

function mixinLifecycleEvents(target) {
    patch(target, 'componentWillMount', true);
    patch(target, 'componentDidMount');
    patch(target, 'componentWillUnmount');

    if (!target.shouldComponentUpdate) {
        target.shouldComponentUpdate = reactiveMixin.shouldComponentUpdate;
    }
}

export const Observer = observer(({ children }) => {
    children = toChildArray(children);
    return children[0]();
});

Observer.displayName = 'Observer';
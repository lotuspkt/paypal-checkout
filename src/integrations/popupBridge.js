/* @flow */

import { once, noop } from 'xcomponent/src/lib';
import { ZalgoPromise } from 'zalgo-promise/src';
import { error } from 'beaver-logger/client';

import { extendUrl, redirect, awaitKey, stringifyError } from '../lib';
import { config } from '../config';
import { FUNDING } from '../constants';

import { determineParameterFromToken, determineUrl } from './checkout';

const OPTYPE = {
    PAYMENT: 'payment',
    CANCEL:  'cancel'
};

type PopupBridge = {
    open : (string) => ZalgoPromise<Object>
};

function wrapPopupBridge(popupBridge : Object) : PopupBridge {
    return {
        open(url : string) : ZalgoPromise<Object> {
            return new ZalgoPromise((resolve, reject) => {
                popupBridge.onComplete = (err, result) => {
                    if (!result) {
                        return reject(new Error('No payload passed in popupBridge.onComplete'));
                    }

                    return err ? reject(err) : resolve(result);
                };
                popupBridge.open(extendUrl(url, { redirect_uri: popupBridge.getReturnUrlPrefix() }));
            });
        }
    };
}

function validateCheckoutProps(props) {
    if (!props.payment) {
        throw new Error(`Expected props.payment to be passed`);
    }

    if (!props.onAuthorize) {
        throw new Error(`Expected props.onAuthorize to be passed`);
    }

    if (props.env && !config.checkoutUrls[props.env]) {
        throw new Error(`Invalid props.env: ${ props.env }`);
    }
}

function normalizeCheckoutProps(props : Object) : { env : string, payment : Function, onAuthorize : Function, onCancel : Function } {
    let env = props.env = props.env || config.env;

    let payment = props.payment;
    let onAuthorize = once(props.onAuthorize);
    let onCancel = once(props.onCancel || noop);

    return { env, payment, onAuthorize, onCancel };
}

function getUrl(props : { env : string, payment : Function, onAuthorize : Function, onCancel? : Function }) : ZalgoPromise<string> {

    let { env, payment } = normalizeCheckoutProps(props);

    return ZalgoPromise.try(payment, { props }).then(token => {
        if (!token) {
            throw new Error(`Expected props.payment to return a payment id or token`);
        }

        return extendUrl(determineUrl(env, FUNDING.PAYPAL, token), {
            [determineParameterFromToken(token)]: token,

            useraction: props.commit ? 'commit' : '',
            native_xo:  '1'
        });
    });
}

function extractDataFromQuery(query : Object) : Object {

    let data : Object = {
        paymentToken: query.token,
        billingToken: query.ba_token,
        paymentID:    query.paymentId,
        payerID:      query.PayerID,
        intent:       query.intent
    };
    
    let { opType, return_uri, cancel_uri } = query;

    if (opType === OPTYPE.PAYMENT) {
        data.returnUrl = return_uri;

    } else if (opType === OPTYPE.CANCEL) {
        data.cancelUrl = cancel_uri;
    }

    return data;
}

function buildActions(query : Object) : Object {
    
    let actions : Object = {
        close:          noop,
        closeComponent: noop
    };

    let { opType, return_uri, cancel_uri } = query;

    if (opType === OPTYPE.PAYMENT) {
        actions.redirect = (win : CrossDomainWindowType = window, redirectUrl : string = return_uri) : ZalgoPromise<void> => {
            return redirect(win, redirectUrl);
        };

    } else if (opType === OPTYPE.CANCEL) {
        actions.redirect = (win : CrossDomainWindowType = window, redirectUrl : string = cancel_uri) : ZalgoPromise<void> => {
            return redirect(win, redirectUrl);
        };
    }

    return actions;
}

function renderThroughPopupBridge(props : Object, popupBridge : PopupBridge) : ZalgoPromise<void> {
    return ZalgoPromise.try(() => {

        validateCheckoutProps(props);

    }).then(() => {

        return getUrl(props);
        
    }).then(url => {

        return popupBridge.open(url);

    }).then(payload => {

        let { opType } = payload.queryItems;
        let { onAuthorize, onCancel } = normalizeCheckoutProps(props);

        let data    = extractDataFromQuery(payload.queryItems);
        let actions = buildActions(payload.queryItems);
        
        if (opType === OPTYPE.PAYMENT) {
            return onAuthorize(data, actions);

        } else if (opType === OPTYPE.CANCEL) {
            return onCancel(data, actions);

        } else {
            throw new Error(`Invalid opType: ${ opType }`);
        }

    });
}

export function awaitPopupBridge() : ZalgoPromise<PopupBridge> {
    if (window.xprops && window.xprops.awaitPopupBridge) {
        return window.xprops.awaitPopupBridge();
    }

    return awaitKey(window, 'popupBridge').then(popupBridge => {
        return wrapPopupBridge(popupBridge);
    });
}

export function setupPopupBridgeProxy(Checkout : Object) {

    let popupBridge;

    awaitPopupBridge().then(bridge => {
        popupBridge = bridge;
    });

    function doRender(props, original) : ZalgoPromise<void> {
        if (!popupBridge) {
            return original();
        }
        
        return renderThroughPopupBridge(props, popupBridge)
            .catch(err => {
                error(`popup_bridge_error`, { err: stringifyError(err) });
                return original();
            });
    }

    let render = Checkout.render;
    Checkout.render = function popupBridgeRender(props : Object) : ZalgoPromise<void> {
        return doRender(props, () => render.apply(this, arguments));
    };

    let renderTo = Checkout.renderTo;
    Checkout.renderTo = function popupBridgeRenderTo(win : CrossDomainWindowType, props : Object) : ZalgoPromise<void> {
        return doRender(props, () => renderTo.apply(this, arguments));
    };

    let renderPopupTo = Checkout.renderPopupTo;
    Checkout.renderPopupTo = function popupBridgeRenderPopupTo(win : CrossDomainWindowType, props : Object) : ZalgoPromise<void> {
        return doRender(props, () => renderPopupTo.apply(this, arguments));
    };
}

/**
 * Compatibility re-export. The Observatory *is* the Project: implementation
 * lives in projectService.js. Existing require('@goobster/core/services/observatoryService')
 * callers keep working; tables, routes, and the observatory tool are unchanged.
 *
 * The one addition is the feature-state seam (#318 review). Every execution
 * entry point (run, resume, render, fetch data, the agent command turn)
 * starts with `_requireEnabled`, and `executionEnabled` is what the tool
 * registry and the resume step read. Both also honour an *enforced* refusal
 * of the `observatory` feature, which includes a sandbox or projects that are
 * enforced off (the dependency rule). Enforcement is the rule, not the
 * reported state: with no usable `data/features.json` and no
 * `GOOBSTER_FEATURE_OBSERVATORY` override nothing changes.
 */
const service = require('./projectService');
const { features } = require('../features/featureState');
const { unavailableResult } = require('../features/gate');

const FEATURE_ID = 'observatory';

function patchExecutionSeam(target) {
    if (target.__featureSeam) return target;
    const proto = Object.getPrototypeOf(target);
    const reported = Object.getOwnPropertyDescriptor(proto, 'executionEnabled');
    const requireEnabled = target._requireEnabled;

    Object.defineProperty(target, 'executionEnabled', {
        configurable: true,
        get() {
            return reported.get.call(this) && !features.enforcedOff(FEATURE_ID);
        }
    });

    target._requireEnabled = async function featureGatedRequireEnabled(...args) {
        if (features.enforcedOff(FEATURE_ID)) {
            const refusal = unavailableResult(FEATURE_ID);
            const error = new service.ObservatoryError(404, refusal.code,
                'Code execution is not available on this installation.');
            error.feature = refusal.feature;
            throw error;
        }
        return requireEnabled.apply(this, args);
    };
    Object.defineProperty(target, '__featureSeam', { value: true });
    return target;
}

module.exports = patchExecutionSeam(service);

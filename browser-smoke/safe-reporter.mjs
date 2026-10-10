// Remote failures can contain service URLs, session identities, or payloads.
// Emit only authored names, outcomes and numeric durations; never serialize browser errors.
export default class SafeReporter {
    onStepEnd(_test, _result, step) {
        if (step.category === 'test.step' && step.error) {
            console.error(`FAILED STEP: ${step.title}`);
        }
    }

    onTestEnd(test, result) {
        const duration = Number.isFinite(result.duration) && result.duration >= 0
            ? ` (${Math.round(result.duration)} ms)` : '';
        console.log(`${result.status.toUpperCase()}: ${test.title}${duration}`);
    }

    onError() {
        console.error('Browser smoke setup/runner failed. Target may be unavailable or unsupported; inspect privately.');
    }

    onEnd(result) {
        console.log(`Browser smoke: ${result.status}`);
    }
}

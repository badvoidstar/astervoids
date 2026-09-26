// Remote failures can contain service URLs, session identities, or payloads.
// Emit only authored scenario names and outcomes; never serialize browser errors.
export default class SafeReporter {
    onStepEnd(_test, _result, step) {
        if (step.category === 'test.step' && step.error) {
            console.error(`FAILED STEP: ${step.title}`);
        }
    }

    onTestEnd(test, result) {
        console.log(`${result.status.toUpperCase()}: ${test.title}`);
    }

    onError() {
        console.error('Browser smoke setup/runner failed. Target may be unavailable or unsupported; inspect privately.');
    }

    onEnd(result) {
        console.log(`Browser smoke: ${result.status}`);
    }
}

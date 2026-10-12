// Remote failures can contain service URLs, session identities, or payloads.
// Emit only authored names, outcomes and numeric durations; never serialize browser errors.
function durationSuffix(duration) {
    return Number.isFinite(duration) && duration >= 0 ? ` (${Math.round(duration)} ms)` : '';
}

export default class SafeReporter {
    onStepEnd(test, _result, step) {
        if (step.category !== 'test.step') return;
        const message = `${step.error ? 'FAILED STEP' : 'STEP'}: ${test.title} > ${step.title}${durationSuffix(step.duration)}`;
        if (step.error) console.error(message);
        else console.log(message);
    }

    onTestEnd(test, result) {
        console.log(`${result.status.toUpperCase()}: ${test.title}${durationSuffix(result.duration)}`);
    }

    onError() {
        console.error('Browser smoke setup/runner failed. Target may be unavailable or unsupported; inspect privately.');
    }

    onEnd(result) {
        console.log(`Browser smoke: ${result.status}`);
    }
}

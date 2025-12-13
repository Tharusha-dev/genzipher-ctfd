CTFd._internal.challenge.data = undefined;

CTFd._internal.challenge.preRender = function () { }

CTFd._internal.challenge.render = function (markdown) {
    return CTFd.markdown(markdown);
}

CTFd._internal.challenge.postRender = function () {
    var $ = CTFd.lib.$;

    $('body').off('click', '#cp-challenge-submit').on('click', '#cp-challenge-submit', function (e) {
        e.preventDefault();
        
        // 1. UI: Set "Running" State
        var $btn = $(this);
        var $spinner = $('#submit-spinner');
        var $label = $('#submit-label');
        var $consoleArea = $('#cp-console-area');
        var $consoleOutput = $('#cp-console-output');
        var $statusBadge = $('#cp-status-badge');

        // Disable button, show spinner
        $btn.prop('disabled', true);
        $spinner.show();
        $label.text("Running...");
        
        // Reset and Show Console
        $consoleArea.show();
        $statusBadge.removeClass().addClass('badge badge-warning').text('Running Tests...');
        $consoleOutput.text("Compiling and executing code on server...\n");

        // 2. Perform Request
        CTFd._internal.challenge.submit()
            .then(function (response) {
                // 3. UI: Handle Completion
                $btn.prop('disabled', false);
                $spinner.hide();
                $label.text("Submit Code");

                // Parse the inner data structure
                // Note: Based on your log, the actual result is in response.data
                var resultData = response.data || response; 
                var status = resultData.status; // "incorrect" or "correct"
                var message = resultData.message || "No output returned.";

                // Update Status Badge
                if (status === "correct") {
                    $statusBadge.removeClass().addClass('badge badge-success').text("ACCEPTED");
                    $consoleOutput.css('color', '#00ff00'); // Green text
                } else {
                    $statusBadge.removeClass().addClass('badge badge-danger').text("WRONG ANSWER / ERROR");
                    $consoleOutput.css('color', '#ff4444'); // Red text
                }

                // Update Console Text
                // If the backend sends raw error lines, they appear here.
                $consoleOutput.text(message);
                
                // If correct, trigger standard CTFd solve behavior (confetti, etc) if you want
                if (status === "correct") {
                   // Optional: CTFd.lib.form_utils.render_success(...)
                }
            });
    });
}

CTFd._internal.challenge.submit = function (preview) {
    var $ = CTFd.lib.$;
    
    var challenge_id = parseInt($('#challenge-id').val());
    var submission = $('#submission-input').val();
    var language = $('#submission-language').val();

    var body = {
        'challenge_id': challenge_id,
        'submission': submission,
        'language_id': language
    };

    var root = (CTFd.config && CTFd.config.urlRoot) ? CTFd.config.urlRoot : '/';
    var url = root + 'api/v1/challenges/attempt';

    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CSRF-Token': (CTFd.config && CTFd.config.csrfNonce) ? CTFd.config.csrfNonce : ''
        },
        body: JSON.stringify(body)
    }).then(function (response) {
        return response.json();
    }).catch(function(error) {
        console.error("Network Error:", error);
        return { success: false, data: { status: "incorrect", message: "Network Error: Could not reach server." } };
    });
};
from CTFd.models import db, Challenges
from CTFd.plugins.challenges import BaseChallenge
from CTFd.plugins import register_plugin_assets_directory
from flask import Blueprint, request, jsonify
import json
import requests

class CPChallenge(Challenges):
    __mapper_args__ = {'polymorphic_identity': 'cp'}
    id = db.Column(None, db.ForeignKey('challenges.id'), primary_key=True)
    
    # Store test cases as JSON: [{"input": "1", "output": "1"}, ...]
    test_cases = db.Column(db.Text, default="[]")
    
    # Time limit in SECONDS (e.g., 1.0)
    time_limit = db.Column(db.Float, default=1.0)
    memory_limit = db.Column(db.Integer, default=128000) # in KB

class CPChallengeType(BaseChallenge):
    id = "cp"
    name = "CP Challenge"
    templates = {
        'create': '/plugins/cp_challenges/assets/create.html',
        'update': '/plugins/cp_challenges/assets/update.html',
        'view': '/plugins/cp_challenges/assets/view.html',
    }
    scripts = {
        'create': '/plugins/cp_challenges/assets/create.js',
        'update': '/plugins/cp_challenges/assets/update.js',
        'view': '/plugins/cp_challenges/assets/view.js',
    }
    challenge_model = CPChallenge

    @staticmethod
    def attempt(challenge, request):
        data = request.form or request.get_json()
        
        # 1. SANITIZATION: Fix the "Non-Breaking Space" syntax crash
        raw_code = data['submission']
        user_code = raw_code.replace('\xa0', ' ')

        # Default to Python (71)
        language_id = int(data.get('language_id', 71)) 
        
        try:
            test_cases = json.loads(challenge.test_cases)
        except:
            return False, "Error: Invalid Test Case Configuration by Admin"

        if not test_cases:
            return False, "Error: No test cases defined"

        # 2. SAFETY: Cap the Time Limit to prevent 422 Errors
        # Judge0 usually rejects anything > 10-15 seconds
        safe_time_limit = float(challenge.time_limit)
        if safe_time_limit > 10:
            safe_time_limit = 10.0

        for i, case in enumerate(test_cases):
            stdin = case.get('input', '')
            expected = case.get('output', '') # Keep raw for now
            
            payload = {
                "source_code": user_code,
                "language_id": language_id,
                "stdin": stdin,
                # NOTE: We do NOT send 'expected_output' to Judge0.
                # We want to compare it ourselves loosely.
                "cpu_time_limit": safe_time_limit,
                "memory_limit": challenge.memory_limit
            }

            try:
                resp = requests.post(
                    'http://judge0-server:2358/submissions?wait=true', 
                    json=payload,
                    timeout=safe_time_limit + 2 # slight buffer for HTTP timeout
                )
                result = resp.json()
            except Exception as e:
                return False, "Error: Judge Engine unreachable"

            # Check for Compilation/Runtime Errors first
            status_id = result.get('status', {}).get('id')
            
            # Status ID 6 is Compilation Error
            if status_id == 6:
                compile_out = result.get('compile_output', 'Unknown syntax error')
                return False, f"Compilation Error:\n{compile_out}"
            
            # Status IDs > 3 usually mean Runtime Error (SIGSEGV, etc)
            # But since we didn't send expected_output, Judge0 returns "Accepted" (3)
            # as long as the code ran successfully. 
            if status_id > 3:
                 error_desc = result.get('status', {}).get('description', 'Runtime Error')
                 stderr = result.get('stderr')
                 if stderr:
                     error_desc += f"\n{stderr}"
                 return False, f"Runtime Error on Case {i+1}: {error_desc}"

            # 3. LOGIC FIX: Manual "Smart" Comparison
            # Compare stdout vs expected output, ignoring whitespace/newlines
            user_stdout = result.get('stdout') or ""
            
            if user_stdout.strip() == expected.strip():
                continue # Passed this case
            else:
                return False, f"Failed Test Case {i+1}.\nExpected:\n{expected}\n\nGot:\n{user_stdout}"

        return True, "Correct! All test cases passed."

def load(app):
    app.db.create_all()
    from CTFd.plugins.challenges import CHALLENGE_CLASSES
    CHALLENGE_CLASSES['cp'] = CPChallengeType
    register_plugin_assets_directory(app, base_path='/plugins/cp_challenges/assets/')
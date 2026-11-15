#!/usr/bin/env node
// An `ssh` stand-in (WP7): reaches no host and reads no key; prints whether it was started with an agent socket.
process.stdout.write(`ssh-ok agent=${process.env.SSH_AUTH_SOCK ? "yes" : "no"}\n`);

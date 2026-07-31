#!/usr/bin/env node
'use strict';

/**
 * VCP RAG / 记忆能力评估 —— 唯一命令行入口。
 *
 *   node eval/vcp-eval.js help
 *
 * 详见 eval/README.md。
 */

const { main } = require('./lib/cli');

main(process.argv.slice(2))
    .then(code => { process.exitCode = code ?? 0; })
    .catch(error => {
        process.stderr.write(`\n[vcp-eval] ${error.message || error}\n`);
        if (process.env.VCP_EVAL_DEBUG) {
            process.stderr.write(`${error.stack || ''}\n`);
        } else {
            process.stderr.write('（设置 VCP_EVAL_DEBUG=1 可查看完整堆栈）\n');
        }
        process.exitCode = 1;
    });

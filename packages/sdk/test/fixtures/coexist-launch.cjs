// Plain CommonJS entry so every Node version loads the scenario through the CJS
// loader (as a CommonJS app with X-Ray would), with tsx compiling the TS files.
require('tsx/cjs');
require('./coexist.cts');

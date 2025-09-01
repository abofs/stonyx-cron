/**
 * commonJS Bootstrap loading - Stonyx must be loaded first, prior to the rest of the application
 */
const { default:Stonyx } = require('stonyx');
const { default:config } = require('./config/environment.js');

new Stonyx(config, __dirname);

module.exports = Stonyx;

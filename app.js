'use strict';

const Homey = require('homey');

class BestwayApp extends Homey.App {

  async onInit() {
    const { id, version } = this.homey.manifest;
    this.log(`${id} v${version} initialized`);
  }

}

module.exports = BestwayApp;

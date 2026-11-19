'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'msgpackViewer',
  triesKey: 'msgpackViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'convert', title: 'Convert to JSON and from JSON', command: 'msgpackViewer.convert' },
    { id: 'edit', title: 'Edit a value and save', command: 'msgpackViewer.editValue' },
    { id: 'compare', title: 'Compare two files', command: 'msgpackViewer.compare' },
    { id: 'batch', title: 'Batch convert a folder to JSON', command: 'msgpackViewer.batch' },
  ],
};

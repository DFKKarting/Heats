// Voorbeeld van config.local.js - kopieer dit bestand naar config.local.js
// (in dezelfde map) en vul je eigen token in. config.local.js staat in
// .gitignore en gaat dus nooit naar GitHub; dit voorbeeldbestand wel, dus
// zet hier zelf nooit een echt token in.
//
// Het token: fine-grained, enkel voor de repository DFKKarting/Heats, met
// "Actions: Read and write". Daarmee werkt de knop "Ophalen staat aan/uit"
// zonder dat de site erom vraagt.
window.HEATS_CONFIG = {
  githubToken: "",
};

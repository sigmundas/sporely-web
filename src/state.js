export const state = {
  currentScreen: 'home',
  capturedPhotos: [],
  captureDraft: {
    habitat: '',
    notes: '',
    uncertain: false,
    visibility: 'friends',
  },
  batchCount: 0,
  sessionStart: null,
  gps: null,
  flashOn: false,
  cameraStream: null,
  user: null,
  searchQuery: '',
  findsView: 'cards',
  findsGroupBySpecies: false,
}

/* module.ts */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import {createGcpSecretsManagerUpsertAction} from './actions/create'; // ou './actions' dependendo de onde salvou

export const scaffolderBackendModuleGCP = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'scaffolder-backend-module-gcp',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolder }) {
        scaffolder.addActions(
          createGcpSecretsManagerUpsertAction(),
          // ... outras actions que você já tiver ...
        );
      },
    });
  },
});

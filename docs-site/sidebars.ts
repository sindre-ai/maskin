import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    'quick-start',
    'core-concepts',
    'api-reference',
    {
      type: 'category',
      label: 'Tutorials',
      items: [
        'tutorials/product-development-workspace',
        'tutorials/connect-ai-agent',
        'tutorials/automate-with-triggers',
      ],
    },
    'faq',
  ],
};

export default sidebars;

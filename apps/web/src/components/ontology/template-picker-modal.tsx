'use client';

import { Modal } from './modal';
import { TemplateGallery } from './template-gallery';

export function TemplatePickerModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Choose a Template">
      <div className="p-5">
        <p className="mb-4 text-[13px] text-gray-500">
          Start with a pre-built ontology template. This will create node types and edge types.
        </p>
        <TemplateGallery />
      </div>
    </Modal>
  );
}

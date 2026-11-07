import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownEditor from './MarkdownEditor.vue'

describe('MarkdownEditor.vue', () => {
  it('emits textarea edits without changing the supplied text', async () => {
    const wrapper = mount(MarkdownEditor, { props: { modelValue: '# Draft\nLine' } })
    expect(wrapper.find('textarea').element.value).toBe('# Draft\nLine')
    await wrapper.find('textarea').setValue('# Draft changed\nLine')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['# Draft changed\nLine'])
  })

  it('disables editing while a save is pending', () => {
    const wrapper = mount(MarkdownEditor, { props: { modelValue: 'Draft', disabled: true } })
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined()
  })
})

/**
 * 极简插件 UI（脚手架，未在本机编译）。
 * 只暴露：服务地址、提示词、BPM、时长、优先级、生成/取消、状态与进度。
 * 生成后按 DAW 播放走带试听（插件内 processBlock 循环输出）。
 */
#pragma once

#include <JuceHeader.h>

class ArrangementBuddyProcessor;

class ArrangementBuddyEditor : public juce::AudioProcessorEditor,
                               private juce::Timer
{
public:
    explicit ArrangementBuddyEditor (ArrangementBuddyProcessor&);
    ~ArrangementBuddyEditor() override = default;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void generateClicked();
    void cancelClicked();
    void timerCallback() override;

    ArrangementBuddyProcessor& processor;

    juce::Label titleLabel;
    juce::Label statusLabel;
    juce::TextEditor serverEditor;
    juce::TextEditor promptEditor;
    juce::Label bpmLabel;
    juce::Slider bpmSlider;
    juce::Label durationLabel;
    juce::Slider durationSlider;
    juce::ComboBox priorityBox;
    juce::TextButton generateButton { "生成" };
    juce::TextButton cancelButton { "取消" };
    double progressValue = 0.0;
    juce::ProgressBar progressBar;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ArrangementBuddyEditor)
};
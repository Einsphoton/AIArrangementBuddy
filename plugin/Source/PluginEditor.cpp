#include "PluginEditor.h"
#include "PluginProcessor.h"

ArrangementBuddyEditor::ArrangementBuddyEditor (ArrangementBuddyProcessor& owner)
    : AudioProcessorEditor (&owner), processor (owner), progressBar (progressValue)
{
    setSize (520, 340);

    titleLabel.setText ("ArrangementBuddy · AI 生成（本地 Companion）", juce::dontSendNotification);
    titleLabel.setFont (juce::FontOptions (16.0f, juce::Font::bold));
    addAndMakeVisible (titleLabel);

    serverEditor.setText (processor.getBaseUrl());
    serverEditor.setTooltip ("本地服务地址（默认 http://127.0.0.1:8787）");
    addAndMakeVisible (serverEditor);

    promptEditor.setMultiLine (true, true);
    promptEditor.setTextToShowWhenEmpty ("描述想要的音乐：风格 / 乐器 / 情绪 / BPM / 调性……", juce::Colours::grey);
    promptEditor.setText ("epic JRPG battle theme, brass stabs, timpani, distorted guitar, 168 bpm, D minor, no vocals");
    addAndMakeVisible (promptEditor);

    bpmLabel.setText ("BPM", juce::dontSendNotification);
    addAndMakeVisible (bpmLabel);
    bpmSlider.setRange (40.0, 240.0, 1.0);
    bpmSlider.setValue (120.0, juce::dontSendNotification);
    bpmSlider.setTextBoxStyle (juce::Slider::TextBoxRight, true, 60, 18);
    addAndMakeVisible (bpmSlider);

    durationLabel.setText ("时长（秒）", juce::dontSendNotification);
    addAndMakeVisible (durationLabel);
    durationSlider.setRange (5.0, 120.0, 1.0);
    durationSlider.setValue (20.0, juce::dontSendNotification);
    durationSlider.setTextBoxStyle (juce::Slider::TextBoxRight, true, 60, 18);
    addAndMakeVisible (durationSlider);

    priorityBox.addItemList ({ "普通", "高", "紧急" }, 1);
    priorityBox.setSelectedId (1);
    addAndMakeVisible (priorityBox);

    generateButton.onClick = [this] { generateClicked(); };
    cancelButton.onClick = [this] { cancelClicked(); };
    addAndMakeVisible (generateButton);
    addAndMakeVisible (cancelButton);
    addAndMakeVisible (progressBar);

    statusLabel.setText (processor.getStatusText(), juce::dontSendNotification);
    statusLabel.setJustificationType (juce::Justification::centredLeft);
    addAndMakeVisible (statusLabel);

    startTimerHz (4);
}

void ArrangementBuddyEditor::generateClicked()
{
    processor.setBaseUrl (serverEditor.getText().trim());
    aiab::GenerateRequest request;
    request.type = "generate_audio";
    request.caption = promptEditor.getText().trim();
    request.bpm = (int) bpmSlider.getValue();
    request.durationSec = durationSlider.getValue();
    request.priority = juce::jmax (0, priorityBox.getSelectedId() - 1);
    processor.generate (request);
}

void ArrangementBuddyEditor::cancelClicked()
{
    processor.cancelGeneration();
}

void ArrangementBuddyEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff111318));
}

void ArrangementBuddyEditor::resized()
{
    auto area = getLocalBounds().reduced (12);
    titleLabel.setBounds (area.removeFromTop (24));
    area.removeFromTop (6);
    serverEditor.setBounds (area.removeFromTop (24));
    area.removeFromTop (6);
    promptEditor.setBounds (area.removeFromTop (110));
    area.removeFromTop (6);

    auto row = area.removeFromTop (26);
    bpmLabel.setBounds (row.removeFromLeft (40));
    bpmSlider.setBounds (row.removeFromLeft (140));
    row.removeFromLeft (10);
    durationLabel.setBounds (row.removeFromLeft (70));
    durationSlider.setBounds (row.removeFromLeft (140));
    row.removeFromLeft (10);
    priorityBox.setBounds (row.removeFromLeft (90));

    area.removeFromTop (8);
    auto buttons = area.removeFromTop (28);
    generateButton.setBounds (buttons.removeFromLeft (100));
    buttons.removeFromLeft (8);
    cancelButton.setBounds (buttons.removeFromLeft (80));

    area.removeFromTop (8);
    progressBar.setBounds (area.removeFromTop (18));
    area.removeFromTop (6);
    statusLabel.setBounds (area.removeFromTop (40));
}
import type {ReactNode} from 'react';
import {KeyboardAvoidingView,Platform,ScrollView,StyleSheet,Text,View} from 'react-native';
import {Brand} from '@/components/Brand';
import {Screen} from '@/components/Screen';
import {colors,spacing} from '@/theme';

export function AccountForm({title,description,children}:{title:string;description:string;children:ReactNode}) {
  return <Screen><KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Brand/><View style={styles.copy}><Text style={styles.title}>{title}</Text><Text style={styles.body}>{description}</Text></View>
      {children}
    </ScrollView>
  </KeyboardAvoidingView></Screen>;
}
export const accountStyles=StyleSheet.create({
  body:{color:colors.textMuted,fontSize:15,lineHeight:23},
  message:{color:colors.success,fontSize:15,lineHeight:23},
  link:{color:colors.primary,fontSize:15,fontWeight:'700'},
});
const styles=StyleSheet.create({
  content:{flexGrow:1,justifyContent:'center',gap:spacing.lg,paddingVertical:spacing.xl,maxWidth:460,width:'100%',alignSelf:'center'},
  copy:{gap:spacing.sm},title:{color:colors.text,fontSize:26,fontWeight:'800'},body:accountStyles.body,
});
